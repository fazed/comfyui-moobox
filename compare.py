from __future__ import annotations

from comfy_api.latest import io, ui


def connected(images: io.Autogrow.Type) -> list[str]:
    return sorted(images, key=lambda name: int(name.removeprefix("image")))


class MooBoxImageCompare(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxImageCompare",
            display_name="Image Compare (MooBox)",
            category="MooBox/LoRA",
            is_output_node=True,
            inputs=[
                io.Autogrow.Input("images", template=io.Autogrow.TemplatePrefix(
                    io.Image.Input("image"), prefix="image", min=2, max=100,
                )),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, images: io.Autogrow.Type) -> io.NodeOutput:
        saved = [{"name": name, **ui.PreviewImage(images[name][:1], cls=cls).values[0]} for name in connected(images)]
        return io.NodeOutput(ui={"compare": saved})


class MooBoxPreviewImages(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxPreviewImages",
            display_name="Preview Images (MooBox)",
            category="MooBox/Utility",
            description="Shows every image of every connected input, one at a time.",
            is_output_node=True,
            inputs=[
                io.Autogrow.Input("images", template=io.Autogrow.TemplatePrefix(
                    io.Image.Input("image"), prefix="image", min=1, max=100,
                )),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, images: io.Autogrow.Type) -> io.NodeOutput:
        return io.NodeOutput(ui={"previews": [file for name in connected(images) for file in ui.PreviewImage(images[name], cls=cls).values]})
