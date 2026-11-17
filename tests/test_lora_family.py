import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from logic import lora_family


def tensor(*shape):
    return {"dtype": "F16", "shape": list(shape), "data_offsets": [0, 0]}


class LoraFamilyTests(unittest.TestCase):
    def test_each_family_by_key_and_width(self):
        self.assertEqual(lora_family({"diffusion_model.blocks.3.attn.wq.lora_A.weight": tensor(16, 6144)}), "Krea 2")
        self.assertEqual(lora_family({"lora_unet_layers_0_proj_q.lora_down.weight": tensor(32, 3072)}), "MOSS")
        self.assertEqual(lora_family({"lora_unet_blocks_7_self_attn_q_proj.lora_down.weight": tensor(32, 2048)}), "Anima")
        self.assertEqual(lora_family({"lora_unet_blocks_7_cross_attn_q_proj.lora_down.weight": tensor(32, 2048)}), "Anima")
        self.assertEqual(lora_family({"lora_unet_input_blocks_4_1_proj_in.lora_down.weight": tensor(8, 640)}), "SDXL")
        self.assertEqual(lora_family({"lora_unet_down_blocks_0_attentions_0_proj_in.lora_down.weight": tensor(8, 320)}), "SDXL")

    def test_specific_layouts_win_over_shared_unet_names(self):
        header = {"lora_unet_up_blocks_0.lora_down.weight": tensor(8, 320), "lora_unet_blocks_0_self_attn_q_proj.lora_down.weight": tensor(8, 2048)}
        self.assertEqual(lora_family(header), "Anima")

    def test_wrong_width_or_missing_shape_is_unknown(self):
        self.assertEqual(lora_family({"lora_unet_blocks_0_self_attn_q_proj.lora_down.weight": tensor(8, 1024)}), "Unknown")
        self.assertEqual(lora_family({"diffusion_model.blocks.0.attn.wq.lora_A.weight": {"dtype": "F16"}}), "Unknown")
        self.assertEqual(lora_family({"lora_unet_layers_0_proj_q.lora_down.weight": tensor(3072)}), "Unknown")
        self.assertEqual(lora_family({"lora_unet_layers_0_proj_q.lora_down.weight": "broken"}), "Unknown")

    def test_empty_and_unrelated_headers_are_unknown(self):
        self.assertEqual(lora_family({}), "Unknown")
        self.assertEqual(lora_family({"lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": tensor(8, 768)}), "Unknown")


if __name__ == "__main__":
    unittest.main()
