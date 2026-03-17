# Example Data

Downsampled (8x) multiplex fluorescence microscopy images for testing FluoroView.
Original resolution: 5625 x 8500 px. Downsampled: 704 x 1063 px.

## Files

| File | Description |
|---|---|
| `Nuclei_channel_8.tif` | DAPI nuclear stain |
| `Cytoplasm_channel_18.tif` | Cytoplasm marker |
| `ECM_16.tif` | Extracellular matrix marker |
| `Membrane_channel_25.tif` | Membrane marker |
| `Nuclear_membrane_channel_20.tif` | Nuclear membrane marker |
| `BEMS340264_Scene-002_cell_mask.tif` | Pre-computed cell segmentation mask |

## Quick Test

```bash
python run_fluoroview.py
```

1. Click **File** and load all 5 channel TIFs (not the mask)
2. Select all 5 in the list, right-click, **Merge Selected as Channels**
3. Click **Seg** → **Import mask (TIFF)** → select `BEMS340264_Scene-002_cell_mask.tif`
4. Click **Cells** → **Current View** → see 4-panel analysis
5. Click **P+/-** → adjust thresholds → see phenotype distributions
