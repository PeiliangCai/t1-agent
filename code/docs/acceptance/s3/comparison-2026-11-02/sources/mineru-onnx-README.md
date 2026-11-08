# MinerU 4 ONNX models

CPU ONNX Runtime models for MinerU's light stack. Requires onnxruntime >= 1.20.1 (ONNX IR 10 support).

- Layout: PP-DocLayoutV2
- OCR: PP-OCRv6 Tiny Det + Small Rec
- Seal: PP-OCRv4 mobile seal detector + shared Small Rec
- Formula: PP-FormulaNet plus-M
- Table: identical to MinerU-4_models_torch

See `manifest.json` for source repositories, exact revisions, SHA-256 checksums, ONNX signatures and export validation. Original model licenses and attribution remain applicable.

OCR uses the single TXT dictionary distributed with MinerU. Prepare these assets with `python -m scripts.prepare_onnx_models prepare`.

## Formula model update (2026-09-11)

PP-FormulaNet plus-M now uses an ONNX graph exported from the matching MinerU-4_models_torch PTH checkpoint. CPU FP32, opset 17, IR 8, dynamic batch and a graph-internal autoregressive Loop. MinerU CPU inference uses batches of up to 8, sorted by original crop area.

The 153-image validation matched the previous ONNX in token sequences and LaTeX, including batches 1/2/4/8/16. The export preserves Torch generation behavior: forced EOS at generated token 1536; the previous ONNX allowed up to 2560 tokens without forced EOS. Validation samples did not reach this boundary. See manifest.json for provenance and hashes.
