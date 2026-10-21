// Fills a dictionary string. {name} is replaced by vars.name. A count that
// changes the words around it is written as a plural block,
// {n|one:# file|other:# files}: the form is picked by the language's plural
// rules (Intl.PluralRules categories: zero, one, two, few, many, other) and
// # becomes the number. "other" is required; the forms can't contain | { }.
const rules = new Map<string, Intl.PluralRules>();

function category(locale: string, n: number) {
  let r = rules.get(locale);
  if (!r) {
    try {
      r = new Intl.PluralRules(locale);
    } catch {
      r = new Intl.PluralRules("en");
    }
    rules.set(locale, r);
  }
  return r.select(n);
}

export function pluralForms(body: string) {
  const forms: Record<string, string> = {};
  for (const part of body.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) forms[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  return forms;
}

export function format(template: string, vars?: Record<string, string | number>, locale = "en") {
  if (!vars) return template;
  return template
    .replace(/\{(\w+)\|([^{}]*)\}/g, (all, k: string, body: string) => {
      if (!(k in vars)) return all;
      const forms = pluralForms(body);
      const n = Number(vars[k]);
      const form = (Number.isFinite(n) ? forms[category(locale, n)] : undefined) ?? forms.other ?? "";
      return form.replace(/#/g, String(vars[k]));
    })
    .replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
