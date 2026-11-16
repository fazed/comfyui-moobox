from comfy_api.latest import ComfyExtension

from .compare import MooBoxImageCompare
from .nodes import MooBoxIllustriousTags, MooBoxLoraLoader, MooBoxSeeds, MooBoxTagPrompt, MooBoxTagTextPrompt, MooBoxTriggerWords
from . import routes

WEB_DIRECTORY = "./web"


class MooBox(ComfyExtension):
    async def get_node_list(self):
        return [MooBoxLoraLoader, MooBoxTriggerWords, MooBoxImageCompare, MooBoxTagPrompt, MooBoxTagTextPrompt, MooBoxIllustriousTags, MooBoxSeeds]


async def comfy_entrypoint():
    return MooBox()
