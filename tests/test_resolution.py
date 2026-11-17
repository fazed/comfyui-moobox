import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from logic import ILLUSTRIOUS_RESOLUTIONS


class IllustriousResolutionTests(unittest.TestCase):
    def test_labels_and_sizes(self):
        self.assertEqual(ILLUSTRIOUS_RESOLUTIONS, {
            "Portrait 832 x 1216 (13:19)": (832, 1216),
            "Portrait 896 x 1152 (7:9)": (896, 1152),
            "Portrait 768 x 1344 (4:7)": (768, 1344),
            "Landscape 1216 x 832 (19:13)": (1216, 832),
            "Landscape 1152 x 896 (9:7)": (1152, 896),
            "Landscape 1344 x 768 (7:4)": (1344, 768),
            "Square 1024 x 1024 (1:1)": (1024, 1024),
        })

    def test_sizes_fit_sdxl_latents(self):
        for width, height in ILLUSTRIOUS_RESOLUTIONS.values():
            self.assertEqual((width % 64, height % 64), (0, 0))

    def test_unknown_label_raises(self):
        with self.assertRaises(KeyError):
            ILLUSTRIOUS_RESOLUTIONS["Portrait 1024 x 1024"]


if __name__ == "__main__":
    unittest.main()
