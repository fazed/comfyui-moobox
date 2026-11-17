import sys
import types
import unittest
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import comfy.samplers
from schedulers import SCHEDULERS, inject_schedulers

NAMES = ["bong_tangent", "beta57", "ays", "ays+", "ays_30", "ays_30+", "gits", "beta_1_1"]


def sdxl_model_sampling():
    betas = torch.linspace(0.00085 ** 0.5, 0.012 ** 0.5, 1000) ** 2
    alphas_cumprod = torch.cumprod(1 - betas, dim=0)
    return types.SimpleNamespace(sigmas=((1 - alphas_cumprod) / alphas_cumprod) ** 0.5)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        inject_schedulers()

    def test_names_are_registered(self):
        self.assertEqual(list(SCHEDULERS), NAMES)
        for name in NAMES:
            self.assertIn(name, comfy.samplers.SCHEDULER_NAMES)
            self.assertIs(comfy.samplers.SCHEDULER_HANDLERS[name], SCHEDULERS[name])

    def test_sigmas_end_at_zero_and_never_rise(self):
        model_sampling = sdxl_model_sampling()
        for name in NAMES:
            for steps in (8, 20, 30):
                with self.subTest(name=name, steps=steps):
                    sigmas = comfy.samplers.calculate_sigmas(model_sampling, name, steps)
                    self.assertEqual(len(sigmas), steps + 1)
                    self.assertEqual(float(sigmas[-1]), 0.0)
                    self.assertTrue(torch.all(sigmas[1:] <= sigmas[:-1]))

    def test_inject_twice_keeps_names_unique(self):
        inject_schedulers()
        for name in NAMES:
            self.assertEqual(comfy.samplers.SCHEDULER_NAMES.count(name), 1)

    def test_existing_handler_is_kept(self):
        handler = comfy.samplers.SCHEDULER_HANDLERS.pop("gits")
        comfy.samplers.SCHEDULER_NAMES.remove("gits")
        other = comfy.samplers.SchedulerHandler(comfy.samplers.simple_scheduler)
        comfy.samplers.SCHEDULER_HANDLERS["gits"] = other
        comfy.samplers.SCHEDULER_NAMES.append("gits")
        try:
            inject_schedulers()
            self.assertIs(comfy.samplers.SCHEDULER_HANDLERS["gits"], other)
            self.assertEqual(comfy.samplers.SCHEDULER_NAMES.count("gits"), 1)
        finally:
            comfy.samplers.SCHEDULER_HANDLERS["gits"] = handler


if __name__ == "__main__":
    unittest.main()
