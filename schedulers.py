from functools import partial
from math import atan, pi

import torch

import comfy.samplers
from comfy.samplers import SchedulerHandler, beta_scheduler, simple_scheduler
from comfy_extras.nodes_align_your_steps import loglinear_interp
from comfy_extras.nodes_gits import NOISE_LEVELS as GITS_NOISE_LEVELS


# From comfyui-ppm (src/schedulers.py):
# Modified AYS by Extraltodeus from https://github.com/Extraltodeus/sigmas_tools_and_the_golden_scheduler/blob/0dc89a264ef346a093d053c0da751f3ece317613/sigmas_merge.py#L203-L233
# 30-step AYS by Koitenshin from https://github.com/AUTOMATIC1111/stable-diffusion-webui/pull/15751#issuecomment-2143648234
def _ays_scheduler(model_sampling, steps, force_sigma_min=False, model_type="SDXL"):
    timestep_indices = {
        "SDXL": [999, 845, 730, 587, 443, 310, 193, 116, 53, 13, 0],
        "SDXL_30": [999, 953, 904, 850, 813, 777, 738, 695, 650, 602, 556, 510, 462, 417, 374, 331, 290, 250, 214, 182, 155, 131, 108, 85, 66, 49, 32, 20, 12, 3, 0],
    }  # fmt: skip
    indices = timestep_indices[model_type]
    sigmas = simple_scheduler(model_sampling, 1000).flip(0)[1:][indices]
    sigmas = loglinear_interp(sigmas.tolist(), steps + 1 if not force_sigma_min else steps)
    sigmas = torch.FloatTensor(sigmas)
    sigmas = torch.cat([sigmas[:-1] if not force_sigma_min else sigmas, torch.FloatTensor([0.0])])
    return torch.FloatTensor(sigmas)


# From comfyui-ppm, copied from comfy_extras.nodes_gits.GITSScheduler
def _gits_scheduler(model_sampling, steps, coeff=1.2):
    if steps <= 20:
        sigmas = GITS_NOISE_LEVELS[round(coeff, 2)][steps - 2][:]
    else:
        sigmas = GITS_NOISE_LEVELS[round(coeff, 2)][-1][:]
        sigmas = loglinear_interp(sigmas, steps + 1)

    sigmas = sigmas[-(steps + 1) :]
    sigmas[-1] = 0
    return torch.FloatTensor(sigmas)


# From RES4LYF (sigmas.py)
def get_bong_tangent_sigmas(steps, slope, pivot, start, end):
    smax = ((2/pi)*atan(-slope*(0-pivot))+1)/2
    smin = ((2/pi)*atan(-slope*((steps-1)-pivot))+1)/2

    srange = smax-smin
    sscale = start - end

    sigmas = [  ( (((2/pi)*atan(-slope*(x-pivot))+1)/2) - smin) * (1/srange) * sscale + end    for x in range(steps)]

    return sigmas

def bong_tangent_scheduler(model_sampling, steps, start=1.0, middle=0.5, end=0.0, pivot_1=0.6, pivot_2=0.6, slope_1=0.2, slope_2=0.2, pad=False):
    steps += 2

    midpoint = int( (steps*pivot_1 + steps*pivot_2) / 2 )
    pivot_1 = int(steps * pivot_1)
    pivot_2 = int(steps * pivot_2)

    slope_1 = slope_1 / (steps/40)
    slope_2 = slope_2 / (steps/40)

    stage_2_len = steps - midpoint
    stage_1_len = steps - stage_2_len

    tan_sigmas_1 = get_bong_tangent_sigmas(stage_1_len, slope_1, pivot_1, start, middle)
    tan_sigmas_2 = get_bong_tangent_sigmas(stage_2_len, slope_2, pivot_2 - stage_1_len, middle, end)

    tan_sigmas_1 = tan_sigmas_1[:-1]
    if pad:
        tan_sigmas_2 = tan_sigmas_2+[0]

    tan_sigmas = torch.tensor(tan_sigmas_1 + tan_sigmas_2)

    return tan_sigmas


SCHEDULERS = {
    # From RES4LYF (__init__.py)
    "bong_tangent": SchedulerHandler(bong_tangent_scheduler),
    "beta57": SchedulerHandler(partial(beta_scheduler, alpha=0.5, beta=0.7)),
    "ays": SchedulerHandler(partial(_ays_scheduler, force_sigma_min=False, model_type="SDXL")),
    "ays+": SchedulerHandler(partial(_ays_scheduler, force_sigma_min=True, model_type="SDXL")),
    "ays_30": SchedulerHandler(partial(_ays_scheduler, force_sigma_min=False, model_type="SDXL_30")),
    "ays_30+": SchedulerHandler(partial(_ays_scheduler, force_sigma_min=True, model_type="SDXL_30")),
    "gits": SchedulerHandler(partial(_gits_scheduler, coeff=1.2)),
    "beta_1_1": SchedulerHandler(partial(beta_scheduler, alpha=1.0, beta=1.0)),
}


def inject_schedulers():
    for name, handler in SCHEDULERS.items():
        if name not in comfy.samplers.SCHEDULER_HANDLERS:
            comfy.samplers.SCHEDULER_HANDLERS[name] = handler
            comfy.samplers.SCHEDULER_NAMES.append(name)
