from __future__ import annotations

from comfy_api.latest import io, ui


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
        names = sorted(images, key=lambda name: int(name.removeprefix("image")))
        saved = [{"name": name, **ui.PreviewImage(images[name][:1], cls=cls).values[0]} for name in names]
        return io.NodeOutput(ui={"compare": saved})
