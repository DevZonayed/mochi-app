# Desktop · Page 13 — Creative Media Studio

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
The brief-to-published pipeline for images, video, avatar, voice, music, captions, and Remotion assembly. Cost transparency is a first-class design element — a video minute can cost $35–45.

## Layout (studio workspace, teal accent zone)
- **Top:** project context chip + pipeline stepper across the top — `Brief → Voice → Avatar → B-roll → Captions → Music → Assemble → Publish` as connected pill stages; completed = filled teal, active = pulsing, future = ghost.
- **Left (320px) — Brief & controls panel:** brief text card; per-stage controls in grouped sections: modality model picker shown as **lane chips** (`Draft lane` grey / `Hero lane` teal / `Self-host` green) — never raw vendor names as primary, model name as caption; duration/resolution steppers; voice picker rows with play buttons; **a persistent cost estimate card** pinned at panel bottom: big mono `≈ $7.80`, breakdown disclosure (per stage line items), turning amber past the project's comfort threshold.
- **Center — canvas:** stage-dependent preview. Video: large rounded player with iOS scrubber; draft variants as a filmstrip beneath (3–4 thumbnails, "Draft · $0.02/s" captions) with a "Re-render hero" teal pill on the selected one. Image: 2×2 variant grid with hover zoom. Render-in-progress: blurred placeholder with progress ring + "Rendering on fal · ~90s" + the job continues in background note.
- **Right (300px) — Queue & assets:** render queue rows (stage, status, cost mono, webhook-wait spinner), then asset bin grid (drag into Assemble), provenance footer per asset ("C2PA ✓ · SynthID ✓").

## Assembly stage
Remotion timeline strip (simple: video track, caption track, music track as colored bars), kinetic-typography template picker as visual thumbnails.

## States
Consent gate: starting any avatar/voice-clone stage without a consent record blocks with an amber card "Consent required before cloning — record it now" + flow. Budget block: red sheet at estimate confirm if cap would be exceeded.

## Micro-interactions
Estimate animates per control change. Draft→hero re-render morphs the thumbnail into the main player. Pipeline stepper stages check off with spring pops.
