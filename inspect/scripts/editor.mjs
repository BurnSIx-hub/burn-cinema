/**
 * 🔥 Осмотр предметов — редактор зоны для ГМа.
 * Одна форма: публичные опции идут в system поведения региона, тексты —
 * в файл хранилища (store.mjs), к игрокам они не попадают.
 */

import { BEHAVIOR_TYPE, SECRET_FIELDS, normalizeSystem, newTextKey, isTextKey } from "./logic.mjs";
import { loadStore, getSecret, setSecrets } from "./store.mjs";

const { ApplicationV2 } = foundry.applications.api;
const L = (k) => game.i18n.localize(`BURNINSPECT.${k}`);


class InspectEditor extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["burn-inspect-editor"],
    tag: "form",
    window: { icon: "fa-solid fa-magnifying-glass", resizable: true },
    position: { width: 560, height: 720 },
    form: { handler: InspectEditor.#onSubmit, closeOnSubmit: true, submitOnChange: false }
  };

  constructor(behavior, options = {}) {
    super({ id: `burn-inspect-editor-${behavior.id}`, ...options });
    this.behavior = behavior;
  }

  get title() {
    const s = normalizeSystem(this.behavior.system);
    return `🔍 ${s.title || this.behavior.parent?.name || L("Thing")}`;
  }

  async _renderHTML() {
    await loadStore();
    const b = this.behavior;
    const fields = b.system.schema.fields;
    const sys = normalizeSystem(b.system);
    const secret = getSecret(sys.textKey);
    const { HTMLField } = foundry.data.fields;

    const group = (name) => fields[name].toFormGroup({ localize: true }, { name: `system.${name}`, value: sys[name], localize: true });
    const secretGroup = (name) => new HTMLField({
      label: `BURNINSPECT.Behavior.FIELDS.${name}.label`,
      hint: `BURNINSPECT.Behavior.FIELDS.${name}.hint`
    }).toFormGroup({ localize: true }, { name: `secret.${name}`, value: secret[name] });

    const root = document.createElement("div");
    root.className = "bie-body";
    const add = (legend, nodes, cls = "") => {
      const fs = document.createElement("fieldset");
      if (cls) fs.className = cls;
      fs.innerHTML = `<legend>${legend}</legend>`;
      for (const n of nodes) fs.append(n);
      root.append(fs);
    };
    add(L("Editor.Item"), [group("title"), secretGroup("text")]);
    add(L("Editor.Check"), [group("checkMode"), group("skill"), group("dc"), secretGroup("textFail")]);
    add(L("Editor.Show"), [group("visibility"), group("range"), group("repeat"), group("sound"), group("duration")]);
    add(`<i class="fa-solid fa-user-secret"></i> ${L("GmOnly")}`, [secretGroup("gmNote")], "bie-gm");

    const note = document.createElement("p");
    note.className = "bie-hint";
    note.innerHTML = L("Editor.SecretHint");
    root.prepend(note);

    const footer = document.createElement("footer");
    footer.className = "form-footer";
    footer.innerHTML = `<button type="submit"><i class="fa-solid fa-floppy-disk"></i> ${L("Editor.Save")}</button>`;
    root.append(footer);
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  static async #onSubmit(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const b = this.behavior;
    let key = normalizeSystem(b.system).textKey;
    if (!isTextKey(key)) key = newTextKey();
    const sys = normalizeSystem({ ...b.system, ...(data.system ?? {}), textKey: key });
    const secret = {};
    for (const f of SECRET_FIELDS) secret[f] = data.secret?.[f] ?? "";
    // Сначала тексты: если запись файла упадёт, зона не останется с ключом без текстов.
    await setSecrets({ [key]: secret });
    await b.update({ system: sys });
    ui.notifications.info(L("Editor.Saved"));
  }
}

export function openInspectEditor(behavior) {
  if (!game.user.isGM || behavior?.type !== BEHAVIOR_TYPE) return;
  const id = `burn-inspect-editor-${behavior.id}`;
  const existing = foundry.applications.instances.get(id);
  if (existing) return existing.render({ force: true });
  new InspectEditor(behavior).render({ force: true });
}

