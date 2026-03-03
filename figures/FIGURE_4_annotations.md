# Figure 4: Collaborative Annotation System

## Purpose
Demonstrate the author-tracked annotation system with identity control, threaded replies, and permission locking. This is a unique feature that differentiates FluoroView from all competitors.

## Final Image Size
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 4 inches (1200 px at 300 DPI)
- **File**: `figures/annotations.png`

## Layout: 3-panel horizontal strip (A, B, C)

### Panel A (left, ~40% width): "Annotation Pins on Tissue"
**What to show**: A zoomed view of tissue with 2-3 annotation pins placed at different locations, each showing the author name.

**How to capture**:
1. First, set your display name: click "Name" button → enter "Arvin"
2. Click the Pin button in the Annotations panel
3. Click on 2-3 different locations on the tissue
4. Enter note text for each (e.g., "High PSMA expression", "Tumor border", "Normal gland")
5. Zoom to see all pins in one view
6. Screenshot the canvas area

**Key details visible**:
- Colored circular pins (yellow by default) with white inner dot
- Author name "Arvin" next to each pin
- Reply count if any (e.g., "Arvin (2)")
- Tissue image visible behind the pins
- Pins should be spread across different tissue structures

### Panel B (center, ~35% width): "Thread Reply Dialog"
**What to show**: The thread dialog window open, showing an annotation with multiple replies.

**How to capture**:
1. Select an annotation in the list
2. Click "Reply" or double-click the annotation
3. Add 2-3 replies to simulate a conversation:
   - Reply 1: "Agree, this region shows strong membrane staining" (from "Arvin")
   - Reply 2: (If possible, create a fake reply from another "author" by editing the session file, or just show your own replies)
4. Screenshot the thread dialog showing:
   - Original note at top (author, timestamp)
   - Replies below with author names, timestamps, text
   - Reply input field at bottom with send button
   - Edit/delete buttons (pencil + X icons) visible only on your own replies

**Key details**:
- The header showing author + timestamp
- The reply list with indented styling
- The dark theme UI of the dialog
- The text input field with send arrow button

### Panel C (right, ~25% width): "Annotation Panel"
**What to show**: The annotation panel in the right sidebar showing the notes list.

**How to capture**:
1. Make sure the "Notes" tab is selected in the bottom panel
2. Have at least 3 annotations in the list
3. Screenshot showing:
   - "Annotations" header with "Name" button
   - Pin, Edit, Del buttons with icons
   - Eye (visibility toggle) button
   - List showing: lock icon (for non-owned) or space, [Author], text preview, reply count
   - Detail area at bottom showing author, time, status (You/Locked)

**Key details**:
- Show at least one annotation with a lock icon 🔒 (to demonstrate permission control)
- Show the detail text at the bottom of the panel
- Dark theme styling

### Simulating Multi-User Scenario (for the lock icon)
To show the lock icon on a foreign annotation:
1. Save a session with some annotations
2. Edit `~/.fluoroview_user.json` to temporarily change your machine_id
3. Or: manually edit the .fluoroview.npz session file to add an annotation with a different machine_id
4. Load the session — foreign annotations will show 🔒

Alternative: Just add a small text callout label saying "🔒 = created by another user (read-only)" without actually showing it in the UI.

## Assembly Instructions
1. Capture all 3 panels
2. In PowerPoint/Keynote, create a 7" × 4" slide
3. Place panels side by side with 8px gaps
4. Add **A**, **B**, **C** labels (bold white 14pt) in top-left of each panel
5. Add thin white borders
6. Optional: Add small white callout labels pointing to key features:
   - "Author name" → pin label
   - "Threaded replies" → reply list
   - "🔒 Permission locked" → lock icon
7. Export as PNG at 300 DPI

## Caption (already in paper.md)
"Annotation system: (A) Pins on tissue showing author names and reply counts. (B) Thread dialog with original note, multiple replies from different users, and permission indicators (lock icon for non-owned notes). (C) Annotation panel showing notes list with author, time, and ownership status."
