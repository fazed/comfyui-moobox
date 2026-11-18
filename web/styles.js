// Imported by every module that uses moobox.css; a module runs once, so the sheet is linked once.
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./moobox.css", import.meta.url).href;
document.head.append(style);
