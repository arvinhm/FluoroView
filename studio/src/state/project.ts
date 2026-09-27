/**
 * Regions, notes, measurements and the line profile of each open scan. The engine owns the data;
 * this store mirrors it, applies edits optimistically while dragging and commits on release.
 */

import { create } from "zustand";
import { ApiError, project as papi } from "../api/client";
import type { Annotation, Measurement, Point, Profile, Project, Region, RegionShape } from "../api/types";
import { useStudio } from "./store";

export interface Line {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Selection = { kind: "region" | "note"; id: string } | null;

export interface MeasureEntry {
  /** `modified` stamp of the region the numbers belong to */
  modified: string;
  data: Measurement | null;
  loading: boolean;
  error: string | null;
  /** the region is being moved or reshaped; the numbers are for where it was */
  stale: boolean;
}

export interface Scan {
  regions: Region[];
  notes: Annotation[];
  background: string | null;
}

interface ProjectState {
  scans: Record<string, Scan>;
  measures: Record<string, MeasureEntry>;
  selection: Selection;
  /** at most one profile line, on the active scan */
  line: (Line & { dsId: string }) | null;
  profile: Profile | null;
  profileError: string | null;
  profileLoading: boolean;
  /** sample under the chart cursor, mirrored as a dot on the line */
  profileHover: number | null;
  noteDraft: Point | null;
}

export const EMPTY_SCAN: Scan = { regions: [], notes: [], background: null };
const MEASURE_CONCURRENCY = 2;
const AUTHOR_KEY = "fluoroview.author";

export const useProject = create<ProjectState>(() => ({
  scans: {},
  measures: {},
  selection: null,
  line: null,
  profile: null,
  profileError: null,
  profileLoading: false,
  profileHover: null,
  noteDraft: null,
}));

export function useScan(dsId: string | null): Scan {
  return useProject((s) => (dsId ? s.scans[dsId] : undefined) ?? EMPTY_SCAN);
}

export function measureKey(dsId: string, rid: string): string {
  return `${dsId}/${rid}`;
}

export function author(): string | null {
  return localStorage.getItem(AUTHOR_KEY) || null;
}

export function setAuthor(name: string): void {
  if (name.trim()) localStorage.setItem(AUTHOR_KEY, name.trim());
  else localStorage.removeItem(AUTHOR_KEY);
}

function scanOf(dsId: string): Scan {
  return useProject.getState().scans[dsId] ?? EMPTY_SCAN;
}

function patchScan(dsId: string, change: (s: Scan) => Partial<Scan>): void {
  useProject.setState((st) => {
    const cur = st.scans[dsId] ?? EMPTY_SCAN;
    return { scans: { ...st.scans, [dsId]: { ...cur, ...change(cur) } } };
  });
}

function report(e: unknown): void {
  useStudio.getState().setNotice(e instanceof Error ? e.message : String(e));
}

/** Rectangles and ellipses live on whole pixels; other vertices keep 1/100 px. */
function tidy(shape: RegionShape, points: Point[]): Point[] {
  const k = shape === "rectangle" || shape === "ellipse" ? 1 : 100;
  return points.map(([x, y]): Point => [Math.round(x * k) / k, Math.round(y * k) / k]);
}

export function select(selection: Selection): void {
  useProject.setState({ selection, noteDraft: null });
}

const requested = new Set<string>();

/** Load a scan's project once per session; later changes are mirrored as they are made. */
export function ensureProject(dsId: string): void {
  if (requested.has(dsId)) return;
  requested.add(dsId);
  void loadProject(dsId);
}

export async function loadProject(dsId: string): Promise<void> {
  try {
    const p = await papi.get(dsId);
    patchScan(dsId, () => ({ regions: p.regions, notes: p.annotations, background: p.background_region }));
    if (p.display) useStudio.getState().applySavedDisplay(dsId, p.display);
  } catch (e) {
    report(e);
  }
}

/** Take a scan's whole project state from the engine (after restoring a session). */
export function setScanState(dsId: string, p: Project): void {
  patchScan(dsId, () => ({ regions: p.regions, notes: p.annotations, background: p.background_region }));
  if (p.display) useStudio.getState().applySavedDisplay(dsId, p.display);
  select(null);
}

// ---- regions -----------------------------------------------------------------------------------

function replaceRegion(dsId: string, region: Region): void {
  patchScan(dsId, (s) => ({ regions: s.regions.map((r) => (r.id === region.id ? region : r)) }));
}

export async function createRegion(dsId: string, shape: RegionShape, points: Point[],
  extra: { name?: string; color?: string } = {}): Promise<Region | null> {
  try {
    const region = await papi.createRegion(dsId, { shape, points: tidy(shape, points), ...extra });
    patchScan(dsId, (s) => ({ regions: [...s.regions, region] }));
    select({ kind: "region", id: region.id });
    measure(dsId, region.id);
    return region;
  } catch (e) {
    report(e);
    return null;
  }
}

/** Local-only change while a region is dragged; `commitRegion` saves it. */
export function previewRegion(dsId: string, rid: string, points: Point[]): void {
  patchScan(dsId, (s) => ({ regions: s.regions.map((r) => (r.id === rid ? { ...r, points } : r)) }));
  setStale(dsId, rid, true);
}

/** Put a previewed region back to its saved shape without saving anything. */
export function revertRegion(dsId: string, rid: string, points: Point[]): void {
  patchScan(dsId, (s) => ({ regions: s.regions.map((r) => (r.id === rid ? { ...r, points } : r)) }));
  setStale(dsId, rid, false);
}

type RegionChange = { points?: Point[]; name?: string };

/** Saves per region: one request in flight; changes made meanwhile are merged and sent next, newest winning. */
const saving = new Map<string, { next: RegionChange | null }>();

async function saveRegion(dsId: string, rid: string, change: RegionChange): Promise<void> {
  const key = measureKey(dsId, rid);
  const queued = saving.get(key);
  if (queued) {
    queued.next = { ...queued.next, ...change };
    return;
  }
  const slot: { next: RegionChange | null } = { next: null };
  saving.set(key, slot);
  let current: RegionChange | null = change;
  try {
    while (current) {
      const saved = await papi.patchRegion(dsId, rid, current);
      current = slot.next;
      slot.next = null;
      if (!current) {
        replaceRegion(dsId, saved);
        measure(dsId, rid);
      }
    }
  } catch (e) {
    report(e);
    await loadProject(dsId);
    setStale(dsId, rid, false);
  } finally {
    saving.delete(key);
  }
}

export function commitRegion(dsId: string, rid: string, points: Point[]): Promise<void> {
  const region = scanOf(dsId).regions.find((r) => r.id === rid);
  if (!region) return Promise.resolve();
  const tidied = tidy(region.shape, points);
  previewRegion(dsId, rid, tidied);
  return saveRegion(dsId, rid, { points: tidied });
}

export function renameRegion(dsId: string, rid: string, name: string): Promise<void> {
  if (!name.trim()) return Promise.resolve();
  patchScan(dsId, (s) => ({ regions: s.regions.map((r) => (r.id === rid ? { ...r, name: name.trim() } : r)) }));
  return saveRegion(dsId, rid, { name: name.trim() });
}

export async function deleteRegion(dsId: string, rid: string): Promise<void> {
  const scan = scanOf(dsId);
  const region = scan.regions.find((r) => r.id === rid);
  if (!region) return;
  const wasBackground = scan.background === rid;
  try {
    const res = await papi.deleteRegion(dsId, rid);
    patchScan(dsId, (s) => ({ regions: s.regions.filter((r) => r.id !== rid), background: res.background_region }));
    if (useProject.getState().selection?.id === rid) select(null);
    useStudio.getState().setNotice({
      text: `Deleted ${region.name}.`,
      action: { label: "Undo", run: () => void restoreRegion(dsId, region, wasBackground) },
    });
  } catch (e) {
    report(e);
  }
}

async function restoreRegion(dsId: string, region: Region, background: boolean): Promise<void> {
  useStudio.getState().setNotice(null);
  try {
    const again = await papi.restoreRegion(dsId, region);
    patchScan(dsId, (s) => ({ regions: [...s.regions, again] }));
    select({ kind: "region", id: again.id });
    measure(dsId, again.id);
    if (background) await setBackground(dsId, again.id);
  } catch (e) {
    report(e);
  }
}

export async function setBackground(dsId: string, rid: string | null): Promise<void> {
  try {
    const res = await papi.setBackground(dsId, rid);
    patchScan(dsId, () => ({ background: res.background_region }));
    if (rid) measure(dsId, rid);
  } catch (e) {
    report(e);
  }
}

// ---- measurements ------------------------------------------------------------------------------

const queue: (() => Promise<void>)[] = [];
let running = 0;

function pump(): void {
  while (running < MEASURE_CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

function setEntry(key: string, entry: MeasureEntry): void {
  useProject.setState((s) => ({ measures: { ...s.measures, [key]: entry } }));
}

function setStale(dsId: string, rid: string, stale: boolean): void {
  const key = measureKey(dsId, rid);
  const cur = useProject.getState().measures[key];
  if (cur && cur.stale !== stale) setEntry(key, { ...cur, stale });
}

/**
 * Fetch the measurement of a region unless the numbers for its saved state exist, are coming, or
 * failed. Moving a region does not re-measure until it is saved (the saved state changes `modified`).
 */
export function measure(dsId: string, rid: string): void {
  const region = scanOf(dsId).regions.find((r) => r.id === rid);
  if (!region) return;
  const key = measureKey(dsId, rid);
  const cur = useProject.getState().measures[key];
  if (cur && cur.modified === region.modified && (cur.loading || cur.data || cur.error)) return;
  setEntry(key, { modified: region.modified, data: cur?.data ?? null, loading: true, error: null, stale: cur?.stale ?? false });
  queue.push(async () => {
    const latest = scanOf(dsId).regions.find((r) => r.id === rid);
    if (!latest || latest.modified !== region.modified) return;
    try {
      const data = await papi.measurement(dsId, rid);
      if (scanOf(dsId).regions.find((r) => r.id === rid)?.modified === region.modified) {
        setEntry(key, { modified: region.modified, data, loading: false, error: null, stale: false });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        window.setTimeout(() => {
          useProject.setState((s) => {
            const measures = { ...s.measures };
            delete measures[key];
            return { measures };
          });
          measure(dsId, rid);
        }, 1500);
        return;
      }
      setEntry(key, { modified: region.modified, data: null, loading: false, error: (e as Error).message, stale: false });
    }
  });
  pump();
}

export function measureAll(dsId: string): void {
  for (const r of scanOf(dsId).regions) measure(dsId, r.id);
}

// ---- notes -------------------------------------------------------------------------------------

export function startNote(p: Point): void {
  useProject.setState({ noteDraft: p, selection: null });
}

export function cancelNote(): void {
  useProject.setState({ noteDraft: null });
}

function replaceNote(dsId: string, note: Annotation): void {
  patchScan(dsId, (s) => ({ notes: s.notes.map((n) => (n.id === note.id ? note : n)) }));
}

export async function saveNote(dsId: string, text: string): Promise<void> {
  const at = useProject.getState().noteDraft;
  if (!at || !text.trim()) return;
  try {
    const note = await papi.createNote(dsId, { x: at[0], y: at[1], text, author: author() });
    patchScan(dsId, (s) => ({ notes: [...s.notes, note] }));
    useProject.setState({ noteDraft: null, selection: { kind: "note", id: note.id } });
  } catch (e) {
    report(e);
  }
}

export function previewNote(dsId: string, aid: string, p: Point): void {
  patchScan(dsId, (s) => ({ notes: s.notes.map((n) => (n.id === aid ? { ...n, x: p[0], y: p[1] } : n)) }));
}

export async function editNote(dsId: string, aid: string, change: { text?: string; x?: number; y?: number }): Promise<void> {
  try {
    replaceNote(dsId, await papi.patchNote(dsId, aid, change));
  } catch (e) {
    report(e);
    void loadProject(dsId);
  }
}

export async function replyToNote(dsId: string, aid: string, text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    replaceNote(dsId, await papi.reply(dsId, aid, text, author()));
  } catch (e) {
    report(e);
  }
}

export async function deleteNote(dsId: string, aid: string): Promise<void> {
  const note = scanOf(dsId).notes.find((n) => n.id === aid);
  if (!note) return;
  try {
    await papi.deleteNote(dsId, aid);
    patchScan(dsId, (s) => ({ notes: s.notes.filter((n) => n.id !== aid) }));
    if (useProject.getState().selection?.id === aid) select(null);
    useStudio.getState().setNotice({
      text: "Deleted note.",
      action: { label: "Undo", run: () => void restoreNote(dsId, note) },
    });
  } catch (e) {
    report(e);
  }
}

async function restoreNote(dsId: string, note: Annotation): Promise<void> {
  useStudio.getState().setNotice(null);
  try {
    const again = await papi.restoreNote(dsId, note);
    patchScan(dsId, (s) => ({ notes: [...s.notes, again] }));
    select({ kind: "note", id: again.id });
  } catch (e) {
    report(e);
  }
}

// ---- line profile ------------------------------------------------------------------------------

let profileBusy = false;
let profileNext: (Line & { dsId: string }) | null = null;

async function fetchProfile(line: Line & { dsId: string }): Promise<void> {
  if (profileBusy) {
    profileNext = line;
    return;
  }
  profileBusy = true;
  useProject.setState({ profileLoading: true });
  try {
    const profile = await papi.profile(line.dsId, line);
    if (useProject.getState().line === line) useProject.setState({ profile, profileError: null });
  } catch (e) {
    if (useProject.getState().line === line) useProject.setState({ profileError: (e as Error).message });
  } finally {
    profileBusy = false;
    const next = profileNext;
    profileNext = null;
    if (next && useProject.getState().line === next) void fetchProfile(next);
    else useProject.setState({ profileLoading: false });
  }
}

/** Show a profile line (fetching its values, latest request wins), or remove it with `null`. */
export function setLine(dsId: string, line: Line | null): void {
  if (!line) {
    useProject.setState({ line: null, profile: null, profileError: null, profileHover: null });
    return;
  }
  const next = { ...line, dsId };
  useProject.setState({ line: next });
  void fetchProfile(next);
}

export function setProfileHover(i: number | null): void {
  if (useProject.getState().profileHover !== i) useProject.setState({ profileHover: i });
}
