
const LANGUAGES = [
  ['en_US', 'English'], ['pl_PL', 'Polski'], ['es_ES', 'Español'], ['de_DE', 'Deutsch'], ['it_IT', 'Italiano'],
  ['zh_CN', '中文'], ['ja_JP', '日本語'],
];

const LANGUAGE_KEY = 'mw-language';

function languageFromCode(code) {
  if (!code) return null;
  const exact = LANGUAGES.find(([id]) => id === code);
  if (exact) return exact[0];
  const near = LANGUAGES.find(([id]) => id.slice(0, 2).toLowerCase() === String(code).slice(0, 2).toLowerCase());
  return near ? near[0] : null;
}

function pickLanguage() {
  let saved = null;
  try { saved = localStorage.getItem(LANGUAGE_KEY); } catch (e) { /* ignore */ }
  if (languageFromCode(saved)) return languageFromCode(saved);
  for (const code of navigator.languages || [navigator.language]) {
    if (languageFromCode(code)) return languageFromCode(code);
  }
  return LANGUAGES[0][0];
}

let language = pickLanguage();

async function fetchTranslation(code) {
  try {
    return await (await fetch(new URL('../../locales/' + code + '/main.translation.json', import.meta.url))).json();
  } catch (e) {
    return {};
  }
}

const english = await fetchTranslation(LANGUAGES[0][0]);

let translation = language === LANGUAGES[0][0] ? english : await fetchTranslation(language);

export function text(key, vars) {
  let value = translation[key];
  if (typeof value !== 'string' || !value) value = english[key];
  if (typeof value !== 'string') return '';
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (vars[name] == null ? match : String(vars[name])));
}

export function fillCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((node) => {
    const vars = node.dataset.n != null ? { n: node.dataset.n } : null;
    node.textContent = text(node.dataset.copy, vars);
  });
  // The shared tooltip shows data-title; controls without a visible label also get it as their name.
  root.querySelectorAll('[data-title]').forEach((node) => {
    const unlabeled = node.tagName === 'BUTTON' ? !node.textContent.trim() : /^(INPUT|SELECT|CANVAS)$/.test(node.tagName) && !node.closest('label');
    if (unlabeled && !node.dataset.label) node.setAttribute('aria-label', text(node.dataset.title));
  });
  root.querySelectorAll('[data-label]').forEach((node) => {
    const of = node.dataset.labelSlot ? 'ui.materialWizard.slots.' + node.dataset.labelSlot : node.dataset.labelOf;
    const vars = of ? { name: text(of) } : null;
    node.setAttribute('aria-label', text(node.dataset.label, vars));
  });
  root.querySelectorAll('[data-placeholder]').forEach((node) => {
    node.placeholder = text(node.dataset.placeholder);
  });
}

const languageSelect = document.getElementById('language');

let languageToken = 0;
let languageHook = () => {};

async function applyLanguage(code) {
  const token = ++languageToken;
  const next = code === LANGUAGES[0][0] ? english : await fetchTranslation(code);
  if (token !== languageToken) return;
  language = code;
  translation = next;
  document.documentElement.lang = language.replace('_', '-');
  fillCopy(document);
  document.title = text('ui.materialWizard.pageTitle');
  languageHook();
}

export function init(onChange) {
  languageHook = onChange;
  document.documentElement.lang = language.replace('_', '-');

  LANGUAGES.forEach(([id, name]) => languageSelect.appendChild(new Option(name, id, false, id === language)));
  languageSelect.addEventListener('change', () => {
    try { localStorage.setItem(LANGUAGE_KEY, languageSelect.value); } catch (e) { /* ignore */ }
    applyLanguage(languageSelect.value);
  });

}
