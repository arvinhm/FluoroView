# Figure 7: AI Assistant

## Purpose
Show the built-in AI chat system — setup flow, active conversation, and version history. This is a novel feature not found in any competing tool.

## Final Image Size
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 4.5 inches (1350 px at 300 DPI)
- **File**: `figures/aichat.png`

## Layout: 3-panel horizontal strip (A, B, C)

### Panel A (left, ~35% width): "Setup Dialog"
**What to show**: The AI setup dialog with provider selection and model list.

**How to capture**:
1. Delete `~/.fluoroview_ai.json` to reset saved config (so setup appears)
   ```bash
   rm ~/.fluoroview_ai.json
   ```
2. Click the AI button (robot icon 🤖) in the toolbar
3. The setup dialog should appear showing:
   - "🤖 AI Assistant Setup" title
   - Provider section: radio buttons for 🟢 OpenAI, 💎 Google Gemini, 🟠 Anthropic Claude
   - API Key field (with bullet-masked text if you've entered a key)
   - Note: "(Key is used only for this session — never stored)"
   - Model dropdown populated with available models
   - Status: "✅ N models available — select one"
   - "🚀 Start Chat" button
4. Enter a Gemini API key and wait for models to auto-load
5. Select a model from the dropdown
6. Screenshot the dialog BEFORE clicking Start Chat

**Key details**:
- All three provider options visible
- Google Gemini selected (radio button filled)
- Model dropdown showing a selected model name
- The status message showing models found
- Dark theme styling, rounded corners

### Panel B (center, ~40% width): "Active Chat Session"
**What to show**: An active conversation where the AI has responded to a request.

**How to capture**:
1. Start a chat session (click Start Chat)
2. The chat window should show the system message at top
3. Type a request like: "Add a button to export the current view as a PNG screenshot"
4. Wait for the AI response
5. The response should show:
   - 🧑 You: header with the user's request
   - 🤖 Assistant: header with the response text
   - Code blocks with file headers (📄 filename.py) in orange/yellow
   - Code content in green monospace
   - System message: "✏️ 1 file edit(s) ready. Click '✅ Apply Edits' to write them."
6. Screenshot the chat window with both the question and response visible

**Key details**:
- Chat header showing: provider icon + model name + buttons (🔄 History, ✅ Apply, 🔑 Key, ⚙ Model, 🆕 New)
- User message in blue
- Assistant response in white
- Code blocks with dark background and green text
- File header in orange/yellow
- System messages in gray italic
- Input area at bottom with send arrow button
- The overall dark theme

**Tips**:
- Resize the chat window to be tall enough to show the full conversation
- Use a simple request that produces a short, clear response with one code block

### Panel C (right, ~25% width): "Version History"
**What to show**: The version history timeline showing AI edits.

**How to capture**:
1. Click "Apply Edits" on a code suggestion (this creates a version snapshot)
2. Then ask another question and apply that edit too (to have 2+ entries)
3. Click the 🔄 History button in the chat header
4. The Version History dialog should show:
   - "🔄 AI Edit History" title
   - Table with columns: Time, Description, # files
   - At least 1-2 entries showing timestamps and edit descriptions
   - "↩️ Restore Selected" button at the bottom
5. Screenshot the version history dialog

**Key details**:
- Table rows with timestamps (YYYY-MM-DDTHH:MM:SS format)
- Description column showing the user's request text (truncated)
- Files column showing number of modified files
- The restore button visible
- Dark theme treeview styling

**Alternative if you can't get real AI edits**:
- You can manually create version snapshots by running:
  ```python
  from fluoroview.ai.version_control import VersionControl
  vc = VersionControl()
  vc.snapshot_files(['fluoroview/app.py'], description='Add PNG export button')
  vc.snapshot_files(['fluoroview/ui/theme.py'], description='Update theme colors')
  ```
- Then open the History dialog to see the entries

## Assembly Instructions
1. Capture all 3 panels
2. PowerPoint/Keynote: 7" × 4.5" slide
3. Arrange side by side with 8px gaps
4. Add **A**, **B**, **C** labels (bold white 14pt)
5. Add thin borders
6. Add callout labels:
   - "3 AI providers supported" → provider radio buttons in Panel A
   - "Auto model discovery" → model dropdown in Panel A
   - "Code edit with file path" → code block in Panel B
   - "One-click apply" → Apply Edits button in Panel B
   - "Snapshot-based undo" → restore button in Panel C
7. Export PNG at 300 DPI

## Caption (already in paper.md)
"AI assistant: (A) Setup dialog with provider selection, API key entry, and automatic model discovery. (B) Active chat session showing natural-language request, code edit response, and Apply Edits button. (C) Version history timeline with restore capability."
