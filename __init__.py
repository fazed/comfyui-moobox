from comfy_api.latest import ComfyExtension

from .compare import MooBoxImageCompare, MooBoxPreviewImages
from .nodes import MooBoxGroupsToggle, MooBoxIllustriousResolution, MooBoxIllustriousTags, MooBoxImageSwitch, MooBoxLoraLoader, MooBoxSeeds, MooBoxTagPrompt, MooBoxTagTextPrompt, MooBoxTriggerWords
from .save_image import MooBoxSaveImage
from . import routes
from .schedulers import inject_schedulers

WEB_DIRECTORY = "./web"
inject_schedulers()


class MooBox(ComfyExtension):
    async def get_node_list(self):
        return [MooBoxLoraLoader, MooBoxTriggerWords, MooBoxImageCompare, MooBoxTagPrompt, MooBoxTagTextPrompt, MooBoxIllustriousTags, MooBoxSeeds, MooBoxGroupsToggle, MooBoxImageSwitch, MooBoxPreviewImages, MooBoxIllustriousResolution, MooBoxSaveImage]


async def comfy_entrypoint():
    return MooBox()
