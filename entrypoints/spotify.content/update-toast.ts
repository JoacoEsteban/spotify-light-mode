import css from "./update-toast.css?inline";

export class UpdateToast {
  private readonly host = document.createElement("spotify-light-mode-update");
  private readonly toast = document.createElement("section");
  private readonly version: HTMLParagraphElement;

  constructor() {
    const root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    const { toast } = this;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-label", "Spotify Light Mode extension update");

    const message = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Spotify Light Mode was updated";
    const description = document.createElement("p");
    description.textContent = "Reload this tab to apply the changes.";
    this.version = document.createElement("p");
    this.version.className = "source";
    message.append(title, description, this.version);

    const actions = document.createElement("div");
    actions.className = "actions";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => this.dismiss(() => window.location.reload()));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => this.dismiss());
    actions.append(reload, dismiss);
    toast.append(message, actions);
    root.append(style, toast);
  }

  show(version: string): void {
    this.version.textContent = `Version ${version}`;
    this.host.inert = false;
    this.toast.classList.remove("leaving");
    document.documentElement.append(this.host);
  }

  dismiss(afterDismiss: () => void = () => undefined): void {
    this.host.inert = true;
    const { opacity, transform } = getComputedStyle(this.toast);
    const { style } = this.toast;
    style.setProperty("--exit-opacity", opacity);
    style.setProperty("--exit-transform", transform);
    this.toast.classList.add("leaving");
    void Promise.all(this.toast.getAnimations().map(({ finished }) => finished))
      .then(() => {
        this.remove();
        afterDismiss();
      })
      .catch(() => undefined);
  }

  remove(): void {
    this.host.remove();
  }
}
