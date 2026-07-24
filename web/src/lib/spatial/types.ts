/** Shared types for CoSMoS spatial statistics (client and server agree on these). */

export type MarkMode = "hard" | "confWeighted" | "softRaw";
export type NullMode = "annulus" | "disk";
export type Direction = "enrichment" | "depletion" | "none";

export interface EnrichmentOptions {
  numTypes: number;
  /** scale radii in micrometres, strictly increasing */
  radiiUm: number[];
  /** tissue units → µm */
  umPerUnit: number;
  mode?: NullMode;
  /** stratify the permutation null by compartment (the point of CoSMoS) */
  compartmentAware?: boolean;
  marks?: MarkMode;
  /** ω per cell, required when marks = "confWeighted" */
  confidence?: number[];
  /** raw (NOT graph-smoothed) posteriors, required when marks = "softRaw" */
  posteriors?: number[][];
  numPermutations?: number;
  alpha?: number;
  seed?: number;
  typeNames?: string[];
}

export interface ScalePoint {
  r: number;
  z: number;
  log2e: number;
  p: number;
  q: number;
  /** directed neighbourhood-abundance ratio: weighted #b per a-anchor */
  narAtoB: number;
  narBtoA: number;
}

export interface PairEnrichment {
  a: number;
  b: number;
  aName: string;
  bName: string;
  perScale: ScalePoint[];
  maxAbsZ: number;
  /** Monte-Carlo p for the within-pair max-|z| statistic (multiscale-corrected) */
  pMax: number;
  /** BH-FDR q across pairs — the primary significance criterion */
  qMax: number;
  peakR: number;
  zAtPeak: number;
  log2eAtPeak: number;
  significant: boolean;
  direction: Direction;
}

export interface EnrichmentResult {
  radiiUm: number[];
  typeNames: string[];
  mode: NullMode;
  compartmentAware: boolean;
  /**
   * False when no usable compartment labels were present, so the "stratified"
   * null degenerated to the global one. The UI must not claim
   * architecture-aware inference in that case.
   */
  stratified: boolean;
  numPermutations: number;
  alpha: number;
  pairs: PairEnrichment[];
  engine: "client" | "server";
  disclaimer?: string;
  /** wall-clock milliseconds, for the honest "what did this cost" readout */
  elapsedMs?: number;
}

export interface RefineOptions {
  numTypes: number;
  umPerUnit: number;
  kNeighbors?: number;
  radiusUm?: number;
  betaMax?: number;
  eta?: number;
  features?: number[][];
  markers?: number[][];
  posteriors?: number[][];
  abstainCoverage?: number;
}

export interface RefineResult {
  refinedTypeIndex: number[];
  refinedProbs: number[][];
  rawTypeIndex: number[];
  entropy: number[];
  confidence: number[];
  abstain: boolean[];
  tau: number;
  coverage: number;
  changed: number;
  engine: "client" | "server";
  disclaimer?: string;
}

export interface NicheOptions {
  numTypes: number;
  radiiUm: number[];
  umPerUnit: number;
  numNiches: number;
  compartmentAware?: boolean;
  marks?: MarkMode;
  confidence?: number[];
  nBoot?: number;
  nNull?: number;
  seed?: number;
}

export interface NicheResult {
  nicheOfCell: number[];
  /** G×K readable type fractions per niche */
  signatures: number[][];
  sizes: number[];
  stabilityAri: number;
  silhouette: number;
  /** is there ANY spatial composition structure? */
  pGlobal: number;
  /** does niche structure exceed what compartments already explain? */
  pStratified: number;
  compartmentEnrichment: number[][];
  typeNames: string[];
  stratified?: boolean;
  /**
   * Null draws behind pGlobal/pStratified. The smallest reachable p is
   * 1/(nNull+1), so the UI can distinguish "not significant" from "this test
   * could not have reached significance".
   */
  nNull?: number;
  engine: "client" | "server";
  disclaimer?: string;
}

export interface ContrastResult {
  compartmentAware: EnrichmentResult;
  global: EnrichmentResult;
  stratified: boolean;
}
