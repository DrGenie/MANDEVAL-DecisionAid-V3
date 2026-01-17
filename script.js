'use strict';

/* =========================================================
   Global seed for reproducible mixed-logit draws
   ========================================================= */

const RANDOM_SEED = 123456789; // change only when you want a new fixed panel of draws

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// seeded PRNG instance
let prng = mulberry32(RANDOM_SEED);

/* =========================================================
   Core state
   ========================================================= */

const state = {
  settings: {
    horizonYears: 1,
    population: 1000000,
    currencyLabel: 'local currency units',
    vslMetric: 'vsl',
    vslValue: 5000000,
    vslLow: null,
    vslHigh: null,
    languageStyle: 'plain'
  },
  config: null,
  costs: null,
  derived: null,
  scenarios: []
};

let selectedScenarioId = null;

/* =========================================================
   Mixed logit coefficient means and SDs
   (ASC Policy A, ASC Opt-out, scope, exemptions, coverage, lives)
   Coverage coefficients as estimated in the study.
   ========================================================= */

const mxlCoefs = {
  AU: {
    mild: {
      ascPolicyA: 0.464,
      ascOptOut: -0.572,
      scopeAll: -0.319,
      exMedRel: -0.157,
      exMedRelPers: -0.267,
      cov70: 0.171,
      cov90: 0.158,
      lives: 0.072
    },
    severe: {
      ascPolicyA: 0.535,
      ascOptOut: -0.694,
      scopeAll: 0.190,
      exMedRel: -0.181,
      exMedRelPers: -0.305,
      cov70: 0.371,
      cov90: 0.398,
      lives: 0.079
    }
  },
  IT: {
    mild: {
      ascPolicyA: 0.625,
      ascOptOut: -0.238,
      scopeAll: -0.276,
      exMedRel: -0.176,
      exMedRelPers: -0.289,
      cov70: 0.185,
      cov90: 0.148,
      lives: 0.039
    },
    severe: {
      ascPolicyA: 0.799,
      ascOptOut: -0.463,
      scopeAll: 0.174,
      exMedRel: -0.178,
      exMedRelPers: -0.207,
      cov70: 0.305,
      cov90: 0.515,
      lives: 0.045
    }
  },
  FR: {
    mild: {
      ascPolicyA: 0.899,
      ascOptOut: 0.307,
      scopeAll: -0.160,
      exMedRel: -0.121,
      exMedRelPers: -0.124,
      cov70: 0.232,
      cov90: 0.264,
      lives: 0.049
    },
    severe: {
      ascPolicyA: 0.884,
      ascOptOut: 0.083,
      scopeAll: -0.019,
      exMedRel: -0.192,
      exMedRelPers: -0.247,
      cov70: 0.267,
      cov90: 0.398,
      lives: 0.052
    }
  }
};

const mxlSDs = {
  AU: {
    mild: {
      ascPolicyA: 1.104,
      ascOptOut: 5.340,
      scopeAll: 1.731,
      exMedRel: 0.443,
      exMedRelPers: 1.254,
      cov70: 0.698,
      cov90: 1.689,
      lives: 0.101
    },
    severe: {
      ascPolicyA: 1.019,
      ascOptOut: 5.021,
      scopeAll: 1.756,
      exMedRel: 0.722,
      exMedRelPers: 1.252,
      cov70: 0.641,
      cov90: 1.548,
      lives: 0.103
    }
  },
  IT: {
    mild: {
      ascPolicyA: 1.560,
      ascOptOut: 4.748,
      scopeAll: 1.601,
      exMedRel: 0.718,
      exMedRelPers: 1.033,
      cov70: 0.615,
      cov90: 1.231,
      lives: 0.080
    },
    severe: {
      ascPolicyA: 1.518,
      ascOptOut: 4.194,
      scopeAll: 1.448,
      exMedRel: 0.575,
      exMedRelPers: 1.082,
      cov70: 0.745,
      cov90: 1.259,
      lives: 0.082
    }
  },
  FR: {
    mild: {
      ascPolicyA: 1.560,
      ascOptOut: 4.138,
      scopeAll: 1.258,
      exMedRel: 0.818,
      exMedRelPers: 0.972,
      cov70: 0.550,
      cov90: 1.193,
      lives: 0.081
    },
    severe: {
      ascPolicyA: 1.601,
      ascOptOut: 3.244,
      scopeAll: 1.403,
      exMedRel: 0.690,
      exMedRelPers: 1.050,
      cov70: 0.548,
      cov90: 1.145,
      lives: 0.085
    }
  }
};

const NUM_MXL_DRAWS = 1000;
const coeffNames = [
  'ascPolicyA',
  'ascOptOut',
  'scopeAll',
  'exMedRel',
  'exMedRelPers',
  'cov70',
  'cov90',
  'lives'
];

let standardNormalDraws = [];
let bcrChart = null;
let supportChart = null;

/* =========================================================
   Random draws – deterministic set per session
   ========================================================= */

function randStdNormal() {
  // Box–Muller using the seeded PRNG
  let u = 0;
  let v = 0;
  while (u === 0) u = prng();
  while (v === 0) v = prng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function generateStandardNormalDraws() {
  standardNormalDraws = new Array(NUM_MXL_DRAWS);
  for (let r = 0; r < NUM_MXL_DRAWS; r++) {
    const obj = {};
    coeffNames.forEach(name => {
      obj[name] = randStdNormal();
    });
    standardNormalDraws[r] = obj;
  }
}

/* =========================================================
   Predicted support from mixed logit
   ========================================================= */

function computeSupportFromMXL(config) {
  if (!config) return null;
  const country = config.country || 'AU';
  const outbreak = config.outbreak || 'mild';
  const countryCoefs = mxlCoefs[country];
  const countrySDs = mxlSDs[country];
  if (!countryCoefs || !countrySDs) return null;

  const mean = countryCoefs[outbreak];
  const sd = countrySDs[outbreak];
  if (!mean || !sd) return null;

  const livesPer100k = config.livesPer100k || 0;
  const scope = config.scope || 'highrisk';
  const exemptions = config.exemptions || 'medical';
  const coverage = config.coverage || 0.5;

  let probSum = 0;

  for (let r = 0; r < NUM_MXL_DRAWS; r++) {
    const z = standardNormalDraws[r];

    const beta = {
      ascPolicyA: mean.ascPolicyA + (sd.ascPolicyA || 0) * z.ascPolicyA,
      ascOptOut: mean.ascOptOut + (sd.ascOptOut || 0) * z.ascOptOut,
      scopeAll: mean.scopeAll + (sd.scopeAll || 0) * z.scopeAll,
      exMedRel: mean.exMedRel + (sd.exMedRel || 0) * z.exMedRel,
      exMedRelPers: mean.exMedRelPers + (sd.exMedRelPers || 0) * z.exMedRelPers,
      cov70: mean.cov70 + (sd.cov70 || 0) * z.cov70,
      cov90: mean.cov90 + (sd.cov90 || 0) * z.cov90,
      lives: mean.lives + (sd.lives || 0) * z.lives
    };

    let uMandate = beta.ascPolicyA;
    let uOptOut = beta.ascOptOut;

    // Scope
    if (scope === 'all') {
      uMandate += beta.scopeAll;
    }

    // Exemptions
    if (exemptions === 'medrel') {
      uMandate += beta.exMedRel;
    } else if (exemptions === 'medrelpers') {
      uMandate += beta.exMedRelPers;
    }

    // Coverage (50% is reference)
    if (coverage === 0.7) {
      uMandate += beta.cov70;
    } else if (coverage === 0.9) {
      uMandate += beta.cov90;
    }

    // Lives saved attribute
    uMandate += beta.lives * livesPer100k;

    // Two-alternative logit: mandate vs opt-out
    const diff = uMandate - uOptOut;
    const pMandate = 1 / (1 + Math.exp(-diff));
    probSum += pMandate;
  }

  return probSum / NUM_MXL_DRAWS;
}

/* =========================================================
   Initialisation
   ========================================================= */

function init() {
  initTabs();
  initRangeDisplay();
  initTooltips();
  generateStandardNormalDraws();
  updateSettingsFromForm();
  loadFromStorage();
  attachEventHandlers();
  updateAll();
}

document.addEventListener('DOMContentLoaded', init);

/* =========================================================
   Tabs
   ========================================================= */

function initTabs() {
  const links = document.querySelectorAll('.tab-link');
  const tabs = document.querySelectorAll('.tab-content');

  links.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      links.forEach(b => b.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(tabId);
      if (target) target.classList.add('active');
    });
  });
}

/* Range display for lives slider */

function initRangeDisplay() {
  const range = document.getElementById('cfg-lives');
  const span = document.getElementById('cfg-lives-display');
  if (!range || !span) return;

  const update = () => {
    span.textContent = range.value;
  };
  range.addEventListener('input', update);
  update();
}

/* Tooltips */

function initTooltips() {
  const tooltip = document.getElementById('globalTooltip');
  if (!tooltip) return;

  const hide = () => {
    tooltip.classList.add('tooltip-hidden');
    tooltip.textContent = '';
  };

  document.querySelectorAll('[data-tooltip]').forEach(el => {
    el.addEventListener('mouseenter', () => {
      const rect = el.getBoundingClientRect();
      tooltip.textContent = el.getAttribute('data-tooltip') || '';
      tooltip.classList.remove('tooltip-hidden');
      const top = rect.bottom + window.scrollY + 8;
      const left = rect.left + window.scrollX;
      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
    });
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
  });

  window.addEventListener('scroll', () => {
    tooltip.classList.add('tooltip-hidden');
  });
}

/* =========================================================
   Storage
   ========================================================= */

function loadFromStorage() {
  try {
    const raw = localStorage.getItem('mandeValScenarios');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.scenarios = parsed.map(s => ({
          ...s,
          pinned: !!s.pinned,
          notes: s.notes || ''
        }));
      }
    }
  } catch (e) {
    console.warn('Could not load scenarios from storage', e);
  }
}

function saveToStorage() {
  try {
    localStorage.setItem('mandeValScenarios', JSON.stringify(state.scenarios));
  } catch (e) {
    console.warn('Could not save scenarios to storage', e);
  }
}

/* =========================================================
   Event handlers
   ========================================================= */

function attachEventHandlers() {
  const btnApplySettings = document.getElementById('btn-apply-settings');
  const btnApplyConfig = document.getElementById('btn-apply-config');
  const btnSaveScenario = document.getElementById('btn-save-scenario');
  const btnApplyCosts = document.getElementById('btn-apply-costs');

  if (btnApplySettings) {
    btnApplySettings.addEventListener('click', () => {
      applySettingsFromForm();
    });
  }

  if (btnApplyConfig) {
    btnApplyConfig.addEventListener('click', () => {
      applyConfigFromForm();
      updateAll();
      showToast('Configuration applied.', 'success');
    });
  }

  if (btnSaveScenario) {
    btnSaveScenario.addEventListener('click', () => {
      saveScenario();
    });
  }

  if (btnApplyCosts) {
    btnApplyCosts.addEventListener('click', () => {
      applyCostsFromForm();
      updateAll();
      showToast('Costs applied.', 'success');
    });
  }

  const btnCopyBriefing = document.getElementById('btn-copy-briefing');
  if (btnCopyBriefing) {
    btnCopyBriefing.addEventListener('click', () => {
      copyFromTextarea('scenario-briefing-text');
    });
  }

  const btnCopyBriefingTemplate = document.getElementById('btn-copy-briefing-template');
  if (btnCopyBriefingTemplate) {
    btnCopyBriefingTemplate.addEventListener('click', () => {
      copyFromTextarea('briefing-template');
    });
  }

  const btnCopyAiPrompt = document.getElementById('btn-copy-ai-prompt');
  if (btnCopyAiPrompt) {
    btnCopyAiPrompt.addEventListener('click', () => {
      copyFromTextarea('ai-prompt');
    });
  }

  const btnOpenAi = document.getElementById('btn-open-ai');
  if (btnOpenAi) {
    btnOpenAi.addEventListener('click', () => {
      window.open('https://copilot.microsoft.com/', '_blank');
    });
  }

  // Export buttons
  const btnExportExcel = document.getElementById('btn-export-excel');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnExportPdf = document.getElementById('btn-export-pdf');
  const btnExportWord = document.getElementById('btn-export-word');
  const btnClearStorage = document.getElementById('btn-clear-storage');

  if (btnExportExcel) {
    btnExportExcel.addEventListener('click', () => exportScenarios('excel'));
  }
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => exportScenarios('csv'));
  }
  if (btnExportPdf) {
    btnExportPdf.addEventListener('click', () => exportScenarios('pdf'));
  }
  if (btnExportWord) {
    btnExportWord.addEventListener('click', () => exportScenarios('word'));
  }
  if (btnClearStorage) {
    btnClearStorage.addEventListener('click', () => {
      state.scenarios = [];
      selectedScenarioId = null;
      saveToStorage();
      rebuildScenariosTable();
      updateScenarioBriefingCurrent();
      updateNotesBox();
      showToast('All saved scenarios cleared from this browser.', 'warning');
    });
  }

  // Notes
  const btnSaveNotes = document.getElementById('btn-save-notes');
  if (btnSaveNotes) {
    btnSaveNotes.addEventListener('click', () => {
      const textarea = document.getElementById('scenario-notes');
      if (!selectedScenarioId) {
        showToast('Select a scenario first, then add notes.', 'warning');
        return;
      }
      const s = state.scenarios.find(sc => sc.id === selectedScenarioId);
      if (!s) {
        showToast('Could not find selected scenario.', 'error');
        return;
      }
      s.notes = textarea.value || '';
      saveToStorage();
      showToast('Notes saved for this scenario.', 'success');
    });
  }

  // Clear pins
  const btnClearPins = document.getElementById('btn-clear-pins');
  if (btnClearPins) {
    btnClearPins.addEventListener('click', () => {
      let changed = false;
      state.scenarios.forEach(s => {
        if (s.pinned) {
          s.pinned = false;
          changed = true;
        }
      });
      if (changed) {
        saveToStorage();
        rebuildScenariosTable();
        showToast('All pins cleared.', 'success');
      } else {
        showToast('No scenarios are pinned.', 'warning');
      }
    });
  }

  // Policy question helper buttons
  const btnQMaxSupport = document.getElementById('btn-q-max-support');
  const btnQMaxBcr = document.getElementById('btn-q-max-bcr');
  const btnQRefMandate = document.getElementById('btn-q-ref-mandate');

  if (btnQMaxSupport) {
    btnQMaxSupport.addEventListener('click', () => {
      const el = document.getElementById('policy-question-text');
      if (!el) return;
      el.textContent =
        'To maximise support with a minimum BCR, try different coverage thresholds and exemption policies, save scenarios, and compare pinned options to identify those with high support (≥70%) and BCR ≥1.';
    });
  }

  if (btnQMaxBcr) {
    btnQMaxBcr.addEventListener('click', () => {
      const el = document.getElementById('policy-question-text');
      if (!el) return;
      el.textContent =
        'To maximise BCR with a minimum support level, adjust lives-saved inputs and costs, then compare pinned scenarios that maintain support above your minimum (e.g. 60%) while improving the BCR.';
    });
  }

  if (btnQRefMandate) {
    btnQRefMandate.addEventListener('click', () => {
      const el = document.getElementById('policy-question-text');
      if (!el) return;
      el.textContent =
        'To stay close to a reference mandate, load a reference design for the country, then tweak one feature at a time (such as coverage or exemptions), save variants, and compare them in the pinned panel.';
    });
  }

  // Reference design buttons
  const btnRefAU = document.getElementById('btn-ref-au');
  const btnRefFR = document.getElementById('btn-ref-fr');
  const btnRefIT = document.getElementById('btn-ref-it');

  if (btnRefAU) {
    btnRefAU.addEventListener('click', () => {
      loadReferenceConfig('AU');
    });
  }
  if (btnRefFR) {
    btnRefFR.addEventListener('click', () => {
      loadReferenceConfig('FR');
    });
  }
  if (btnRefIT) {
    btnRefIT.addEventListener('click', () => {
      loadReferenceConfig('IT');
    });
  }
}

/* =========================================================
   Settings & configuration
   ========================================================= */

function updateSettingsFromForm() {
  const horizon = parseFloat(document.getElementById('setting-horizon').value) || 1;
  const pop = parseFloat(document.getElementById('setting-population').value) || 0;
  const currency = document.getElementById('setting-currency').value || 'local currency units';
  const metric = document.getElementById('setting-vsl-metric').value || 'vsl';
  const vslVal = parseFloat(document.getElementById('setting-vsl').value) || 0;

  const vslLowRaw = document.getElementById('setting-vsl-low').value;
  const vslHighRaw = document.getElementById('setting-vsl-high').value;
  const vslLow = vslLowRaw === '' ? null : (parseFloat(vslLowRaw) || null);
  const vslHigh = vslHighRaw === '' ? null : (parseFloat(vslHighRaw) || null);

  const languageStyle = document.getElementById('setting-language-style').value || 'plain';

  state.settings = {
    horizonYears: horizon,
    population: pop,
    currencyLabel: currency,
    vslMetric: metric,
    vslValue: vslVal,
    vslLow,
    vslHigh,
    languageStyle
  };
}

function applySettingsFromForm() {
  updateSettingsFromForm();
  if (state.config) {
    state.derived = computeDerived(state.settings, state.config, state.costs);
  }
  updateAll();
  showToast('Settings applied.', 'success');
}

function applyConfigFromForm() {
  const country = document.getElementById('cfg-country').value;
  const outbreak = document.getElementById('cfg-outbreak').value;
  const scope = document.getElementById('cfg-scope').value;
  const exemptions = document.getElementById('cfg-exemptions').value;
  const coverage = parseFloat(document.getElementById('cfg-coverage').value);
  const livesPer100k = parseFloat(document.getElementById('cfg-lives').value);

  const livesLowRaw = document.getElementById('cfg-lives-low').value;
  const livesHighRaw = document.getElementById('cfg-lives-high').value;
  const livesPer100kLow = livesLowRaw === '' ? null : (parseFloat(livesLowRaw) || null);
  const livesPer100kHigh = livesHighRaw === '' ? null : (parseFloat(livesHighRaw) || null);

  const distributionalFlag = !!document.getElementById('cfg-distribution-flag').checked;

  state.config = {
    country,
    outbreak,
    scope,
    exemptions,
    coverage,
    livesPer100k,
    livesPer100kLow,
    livesPer100kHigh,
    distributionalFlag
  };

  state.derived = computeDerived(state.settings, state.config, state.costs);
}

function applyCostsFromForm() {
  const itSystems = parseFloat(document.getElementById('cost-it-systems').value) || 0;
  const comms = parseFloat(document.getElementById('cost-communications').value) || 0;
  const enforcement = parseFloat(document.getElementById('cost-enforcement').value) || 0;
  const compensation = parseFloat(document.getElementById('cost-compensation').value) || 0;
  const admin = parseFloat(document.getElementById('cost-admin').value) || 0;
  const other = parseFloat(document.getElementById('cost-other').value) || 0;

  const costLowRaw = document.getElementById('cost-total-low').value;
  const costHighRaw = document.getElementById('cost-total-high').value;
  const costTotalLow = costLowRaw === '' ? null : (parseFloat(costLowRaw) || null);
  const costTotalHigh = costHighRaw === '' ? null : (parseFloat(costHighRaw) || null);

  state.costs = {
    itSystems,
    comms,
    enforcement,
    compensation,
    admin,
    other,
    costTotalLow,
    costTotalHigh
  };

  state.derived = computeDerived(state.settings, state.config, state.costs);
}

/* =========================================================
   Derived metrics (central and uncertainty ranges)
   ========================================================= */

function computeDerived(settings, config, costs) {
  if (!config) return null;

  const pop = settings.population || 0;
  const vsl = settings.vslValue || 0;
  const livesPer100k = config.livesPer100k || 0;

  // Central
  const livesTotal = (livesPer100k / 100000) * pop;
  const benefitMonetary = livesTotal * vsl;

  const costTotalCentral = costs
    ? (costs.itSystems || 0) +
      (costs.comms || 0) +
      (costs.enforcement || 0) +
      (costs.compensation || 0) +
      (costs.admin || 0) +
      (costs.other || 0)
    : 0;

  const netBenefit = benefitMonetary - costTotalCentral;
  const bcr = costTotalCentral > 0 ? benefitMonetary / costTotalCentral : null;

  const support = computeSupportFromMXL(config);

  // Uncertainty ranges
  const livesPer100kLow = config.livesPer100kLow != null ? config.livesPer100kLow : livesPer100k;
  const livesPer100kHigh = config.livesPer100kHigh != null ? config.livesPer100kHigh : livesPer100k;

  const vslLow = settings.vslLow != null ? settings.vslLow : vsl;
  const vslHigh = settings.vslHigh != null ? settings.vslHigh : vsl;

  const costTotalLow =
    costs && costs.costTotalLow != null && costs.costTotalLow > 0 ? costs.costTotalLow : costTotalCentral;
  const costTotalHigh =
    costs && costs.costTotalHigh != null && costs.costTotalHigh > 0 ? costs.costTotalHigh : costTotalCentral;

  const livesTotalLow = (livesPer100kLow / 100000) * pop;
  const livesTotalHigh = (livesPer100kHigh / 100000) * pop;

  const benefitMonetaryLow = livesTotalLow * vslLow;
  const benefitMonetaryHigh = livesTotalHigh * vslHigh;

  const netBenefitLow = benefitMonetaryLow - costTotalHigh;
  const netBenefitHigh = benefitMonetaryHigh - costTotalLow;

  const bcrLow = costTotalHigh > 0 ? benefitMonetaryLow / costTotalHigh : null;
  const bcrHigh = costTotalLow > 0 ? benefitMonetaryHigh / costTotalLow : null;

  return {
    livesTotal,
    benefitMonetary,
    costTotal: costTotalCentral,
    netBenefit,
    bcr,
    support,
    livesTotalLow,
    livesTotalHigh,
    benefitMonetaryLow,
    benefitMonetaryHigh,
    costTotalLow,
    costTotalHigh,
    netBenefitLow,
    netBenefitHigh,
    bcrLow,
    bcrHigh
  };
}

/* =========================================================
   Updating the UI
   ========================================================= */

function updateAll() {
  if (state.config && !state.derived) {
    state.derived = computeDerived(state.settings, state.config, state.costs);
  }

  updateConfigSummary();
  updateCostSummary();
  updateResultsSummary();
  rebuildScenariosTable();
  updateBriefingTemplate();
  updateAiPrompt();
  updateScenarioBriefingCurrent();
  updateNotesBox();
}

function updateConfigSummary() {
  const elCountry = document.getElementById('summary-country');
  const elOutbreak = document.getElementById('summary-outbreak');
  const elScope = document.getElementById('summary-scope');
  const elExemptions = document.getElementById('summary-exemptions');
  const elCoverage = document.getElementById('summary-coverage');
  const elLives = document.getElementById('summary-lives');
  const elSupport = document.getElementById('summary-support');
  const elHeadline = document.getElementById('headlineRecommendation');

  if (!state.config || !state.derived) {
    if (elCountry) elCountry.textContent = '–';
    if (elOutbreak) elOutbreak.textContent = '–';
    if (elScope) elScope.textContent = '–';
    if (elExemptions) elExemptions.textContent = '–';
    if (elCoverage) elCoverage.textContent = '–';
    if (elLives) elLives.textContent = '–';
    if (elSupport) elSupport.textContent = '–';
    if (elHeadline) {
      elHeadline.textContent =
        'No configuration applied yet. Configure country, outbreak scenario and design, then click “Apply configuration” to see a summary.';
    }
    updateStatusChips(null, null);
    return;
  }

  const c = state.config;
  const d = state.derived;

  if (elCountry) elCountry.textContent = countryLabel(c.country);
  if (elOutbreak) elOutbreak.textContent = outbreakLabel(c.outbreak);
  if (elScope) elScope.textContent = scopeLabel(c.scope);
  if (elExemptions) elExemptions.textContent = exemptionsLabel(c.exemptions);
  if (elCoverage) elCoverage.textContent = coverageLabel(c.coverage);
  if (elLives) elLives.textContent = `${c.livesPer100k.toFixed(1)} per 100,000`;
  if (elSupport) elSupport.textContent = formatPercent((d.support || 0) * 100);

  if (elHeadline) {
    const supp = (d.support || 0) * 100;
    const bcr = d.bcr;
    const cur = state.settings.currencyLabel;

    let rating;
    if (supp >= 70 && bcr && bcr >= 1) {
      rating =
        'This mandate option combines high predicted public support with a favourable benefit–cost profile given the current assumptions.';
    } else if (supp >= 60 && bcr && bcr >= 1) {
      rating =
        'This mandate option has broadly favourable support and a positive benefit–cost profile, but still involves important trade-offs.';
    } else if (supp < 50 && (!bcr || bcr < 1)) {
      rating =
        'This mandate option has limited predicted support and a weak benefit–cost profile; it may be difficult to justify without additional measures.';
    } else {
      rating =
        'This mandate option involves trade-offs between public support and the economic valuation of lives saved. It warrants careful deliberation.';
    }

    const costText =
      d.costTotal > 0
        ? `Indicative implementation cost is about ${formatCurrency(d.costTotal, cur)} over the selected horizon.`
        : 'Implementation costs have not yet been entered, so the benefit–cost profile is incomplete.';

    elHeadline.textContent =
      `${rating} Predicted public support is approximately ${formatPercent(supp)}. ` +
      `The monetary valuation of lives saved is about ${formatCurrency(d.benefitMonetary, cur)}. ${costText}`;
  }

  updateStatusChips(state.config, state.derived);
}

function updateCostSummary() {
  const elTotal = document.getElementById('summary-cost-total');
  const elMain = document.getElementById('summary-cost-main');
  const cur = state.settings.currencyLabel;

  if (!state.costs) {
    if (elTotal) elTotal.textContent = '–';
    if (elMain) elMain.textContent = '–';
    return;
  }

  const c = state.costs;
  const components = [
    { key: 'itSystems', label: 'Digital systems & infrastructure', value: c.itSystems || 0 },
    { key: 'comms', label: 'Communications & public information', value: c.comms || 0 },
    { key: 'enforcement', label: 'Enforcement & compliance', value: c.enforcement || 0 },
    { key: 'compensation', label: 'Adverse-event monitoring & compensation', value: c.compensation || 0 },
    { key: 'admin', label: 'Administration & programme management', value: c.admin || 0 },
    { key: 'other', label: 'Other mandate-specific costs', value: c.other || 0 }
  ];

  const total = components.reduce((acc, x) => acc + x.value, 0);
  let main = components[0];
  components.forEach(comp => {
    if (comp.value > main.value) main = comp;
  });

  if (elTotal) elTotal.textContent = total > 0 ? formatCurrency(total, cur) : 'Not yet entered';
  if (elMain) elMain.textContent = total > 0 ? `${main.label} (${formatCurrency(main.value, cur)})` : '–';
}

function updateResultsSummary() {
  const d = state.derived;
  const c = state.config;
  const settings = state.settings;
  const cur = settings.currencyLabel;

  const elLivesTotal = document.getElementById('result-lives-total');
  const elBenefit = document.getElementById('result-benefit-monetary');
  const elCost = document.getElementById('result-cost-total');
  const elNet = document.getElementById('result-net-benefit');
  const elBcr = document.getElementById('result-bcr');
  const elSupport = document.getElementById('result-support');
  const elNarrative = document.getElementById('resultsNarrative');
  const elUncert = document.getElementById('uncertaintyNarrative');

  if (!d || !c) {
    if (elLivesTotal) elLivesTotal.textContent = '–';
    if (elBenefit) elBenefit.textContent = '–';
    if (elCost) elCost.textContent = '–';
    if (elNet) elNet.textContent = '–';
    if (elBcr) elBcr.textContent = '–';
    if (elSupport) elSupport.textContent = '–';
    if (elNarrative) {
      elNarrative.textContent =
        'Apply a configuration and, if possible, enter costs to see a narrative summary of cost–benefit performance and model-based public support for the mandate.';
    }
    if (elUncert) {
      elUncert.textContent =
        'If you enter low and high values for lives saved, value per life and total costs, this section will summarise how the benefit–cost ratio changes under more optimistic and more conservative assumptions.';
    }
    updateMRSSection(null);
    updateCharts(null, null);
    updateStatusChips(null, null);
    return;
  }

  if (elLivesTotal) elLivesTotal.textContent = `${d.livesTotal.toFixed(1)} lives`;
  if (elBenefit) elBenefit.textContent = formatCurrency(d.benefitMonetary, cur);
  if (elCost) elCost.textContent = d.costTotal > 0 ? formatCurrency(d.costTotal, cur) : 'Costs not entered';
  if (elNet) elNet.textContent = formatCurrency(d.netBenefit, cur);
  if (elBcr) elBcr.textContent = d.bcr != null ? d.bcr.toFixed(2) : 'not defined';
  if (elSupport) elSupport.textContent = formatPercent((d.support || 0) * 100);

  if (elNarrative) {
    const supp = (d.support || 0) * 100;
    const suppText = `Predicted public support for this configuration is approximately ${formatPercent(supp)}.`;
    const costText =
      d.costTotal > 0
        ? `Total implementation cost is around ${formatCurrency(
            d.costTotal,
            cur
          )}, generating an estimated benefit–cost ratio of ${d.bcr != null ? d.bcr.toFixed(2) : 'not defined'}.`
        : 'Implementation costs have not been entered, so only benefits and support can be interpreted at this stage.';
    const benefitText = `The expected lives saved parameter implies about ${d.livesTotal.toFixed(
      1
    )} lives saved in the exposed population, valued at approximately ${formatCurrency(d.benefitMonetary, cur)}.`;
    elNarrative.textContent = `${suppText} ${benefitText} ${costText}`;
  }

  if (elUncert) {
    if (d.bcrLow != null && d.bcrHigh != null && (d.bcrLow !== d.bcr || d.bcrHigh !== d.bcr)) {
      elUncert.textContent =
        `Under the central assumptions, the benefit–cost ratio is ${d.bcr != null ? d.bcr.toFixed(2) : 'not defined'}. ` +
        `Using the low-benefit/high-cost assumptions, the BCR falls to about ${
          d.bcrLow != null ? d.bcrLow.toFixed(2) : 'not defined'
        }. ` +
        `Under high-benefit/low-cost assumptions, the BCR could rise to about ${
          d.bcrHigh != null ? d.bcrHigh.toFixed(2) : 'not defined'
        }.`;
    } else {
      elUncert.textContent =
        'Uncertainty ranges have not been specified or are identical to the central assumptions. Enter low and high values for lives saved, value per life and total cost to explore a simple sensitivity range.';
    }
  }

  updateMRSSection(c);
  updateCharts(d, settings);
  updateStatusChips(c, d);
}

/* Status chips for support, BCR and data completeness */

function updateStatusChips(config, derived) {
  const chipSupport = document.getElementById('status-support');
  const chipBcr = document.getElementById('status-bcr');
  const chipData = document.getElementById('status-data');

  if (!chipSupport || !chipBcr || !chipData) return;

  if (!config || !derived) {
    chipSupport.textContent = 'Support: –';
    chipSupport.className = 'status-chip status-neutral';
    chipBcr.textContent = 'BCR: –';
    chipBcr.className = 'status-chip status-neutral';
    chipData.textContent = 'Data: –';
    chipData.className = 'status-chip status-neutral';
    return;
  }

  const supp = (derived.support || 0) * 100;
  let supportClass = 'status-chip ';
  let supportText;

  if (supp < 50) {
    supportClass += 'status-bad';
    supportText = 'Support: Low';
  } else if (supp < 70) {
    supportClass += 'status-med';
    supportText = 'Support: Medium';
  } else {
    supportClass += 'status-good';
    supportText = 'Support: High';
  }

  chipSupport.textContent = supportText;
  chipSupport.className = supportClass;

  const bcr = derived.bcr;
  let bcrClass = 'status-chip ';
  let bcrText;

  if (bcr == null) {
    bcrClass += 'status-neutral';
    bcrText = 'BCR: Not defined';
  } else if (bcr < 0.8) {
    bcrClass += 'status-bad';
    bcrText = 'BCR: Unfavourable';
  } else if (bcr < 1.0) {
    bcrClass += 'status-med';
    bcrText = 'BCR: Uncertain';
  } else {
    bcrClass += 'status-good';
    bcrText = 'BCR: Favourable';
  }

  chipBcr.textContent = bcrText;
  chipBcr.className = bcrClass;

  const vslSet = state.settings.vslValue && state.settings.vslValue > 0;
  const costSet = derived.costTotal && derived.costTotal > 0;

  let dataClass = 'status-chip ';
  let dataText;

  if (vslSet && costSet) {
    dataClass += 'status-good';
    dataText = 'Data: Costs & VSL entered';
  } else if (vslSet || costSet) {
    dataClass += 'status-med';
    dataText = 'Data: Partial (costs or VSL missing)';
  } else {
    dataClass += 'status-bad';
    dataText = 'Data: Key inputs missing';
  }

  chipData.textContent = dataText;
  chipData.className = dataClass;
}

/* =========================================================
   MRS section (lives-saved equivalents)
   ========================================================= */

function updateMRSSection(config) {
  const tableBody = document.querySelector('#mrs-table tbody');
  const mrsNarr = document.getElementById('mrsNarrative');
  if (!tableBody) return;

  tableBody.innerHTML = '';

  if (!config) {
    if (mrsNarr) {
      mrsNarr.textContent =
        'Configure a mandate to see how changes in scope, exemptions or coverage compare to changes in expected lives saved. Positive values indicate changes that reduce acceptability; negative values indicate changes that increase acceptability.';
    }
    return;
  }

  const coefs = mxlCoefs[config.country || 'AU'][config.outbreak || 'mild'];
  const betaLives = coefs.lives || 0;
  if (!betaLives) {
    if (mrsNarr) {
      mrsNarr.textContent =
        'Lives-saved equivalents (MRS) are not available because the lives-saved coefficient is missing in the current setting.';
    }
    return;
  }

  const rows = [];

  if (config.scope === 'all') {
    const mrsScope = -coefs.scopeAll / betaLives;
    rows.push({
      attribute: 'Scope: high-risk occupations → all occupations & public spaces',
      value: mrsScope,
      interpretation:
        mrsScope >= 0
          ? `This change is as demanding in acceptability terms as losing about ${mrsScope.toFixed(
              1
            )} expected lives saved per 100,000 people.`
          : `This change increases acceptability, similar to gaining about ${Math.abs(
              mrsScope
            ).toFixed(1)} expected lives saved per 100,000 people.`
    });
  }

  if (config.exemptions === 'medrel') {
    const mrsExMedRel = -coefs.exMedRel / betaLives;
    rows.push({
      attribute: 'Exemptions: medical only → medical + religious',
      value: mrsExMedRel,
      interpretation:
        mrsExMedRel >= 0
          ? `Moving to medical + religious exemptions is viewed as restrictive as losing about ${mrsExMedRel.toFixed(
              1
            )} expected lives saved per 100,000.`
          : `Moving to medical + religious exemptions is viewed as favourable, similar to gaining about ${Math.abs(
              mrsExMedRel
            ).toFixed(1)} expected lives saved per 100,000.`
    });
  } else if (config.exemptions === 'medrelpers') {
    const mrsExMedRelPers = -coefs.exMedRelPers / betaLives;
    rows.push({
      attribute: 'Exemptions: medical only → medical + religious + personal belief',
      value: mrsExMedRelPers,
      interpretation:
        mrsExMedRelPers >= 0
          ? `Allowing medical, religious and personal belief exemptions is viewed as restrictive as losing about ${mrsExMedRelPers.toFixed(
              1
            )} expected lives saved per 100,000.`
          : `Allowing medical, religious and personal belief exemptions is viewed as favourable, similar to gaining about ${Math.abs(
              mrsExMedRelPers
            ).toFixed(1)} expected lives saved per 100,000.`
    });
  }

  if (config.coverage === 0.7) {
    const mrsCov = -coefs.cov70 / betaLives;
    rows.push({
      attribute: 'Coverage threshold: 50% → 70% vaccinated',
      value: mrsCov,
      interpretation:
        mrsCov >= 0
          ? `Raising the lifting threshold to 70% is as demanding as losing about ${mrsCov.toFixed(
              1
            )} expected lives saved per 100,000.`
          : `Raising the lifting threshold to 70% is viewed as beneficial, similar to gaining about ${Math.abs(
              mrsCov
            ).toFixed(1)} expected lives saved per 100,000.`
    });
  } else if (config.coverage === 0.9) {
    const mrsCov = -coefs.cov90 / betaLives;
    rows.push({
      attribute: 'Coverage threshold: 50% → 90% vaccinated',
      value: mrsCov,
      interpretation:
        mrsCov >= 0
          ? `Raising the lifting threshold to 90% is as demanding as losing about ${mrsCov.toFixed(
              1
            )} expected lives saved per 100,000.`
          : `Raising the lifting threshold to 90% is viewed as beneficial, similar to gaining about ${Math.abs(
              mrsCov
            ).toFixed(1)} expected lives saved per 100,000.`
    });
  }

  rows.slice(0, 3).forEach(row => {
    const tr = document.createElement('tr');
    const tdAttr = document.createElement('td');
    const tdVal = document.createElement('td');
    const tdInterp = document.createElement('td');

    tdAttr.textContent = row.attribute;
    tdVal.textContent = row.value.toFixed(1);
    tdInterp.textContent = row.interpretation;

    tr.appendChild(tdAttr);
    tr.appendChild(tdVal);
    tr.appendChild(tdInterp);
    tableBody.appendChild(tr);
  });

  if (mrsNarr) {
    if (!rows.length) {
      mrsNarr.textContent =
        'Under the current configuration there is no attribute change to contrast, so lives-saved equivalents (MRS) are not displayed.';
    } else {
      mrsNarr.textContent =
        'Lives-saved equivalents show how strongly people care about mandate design features in terms of “extra lives saved per 100,000 people”. Positive values reflect changes that reduce acceptability; negative values reflect changes that increase acceptability.';
    }
  }
}

/* =========================================================
   Charts
   ========================================================= */

function updateCharts(derived, settings) {
  const ctxBcr = document.getElementById('chart-bcr');
  const ctxSupport = document.getElementById('chart-support');

  if (!ctxBcr || !ctxSupport) return;

  if (bcrChart) bcrChart.destroy();
  if (supportChart) supportChart.destroy();

  if (!derived) return;

  const cur = settings.currencyLabel;

  bcrChart = new Chart(ctxBcr, {
    type: 'bar',
    data: {
      labels: ['Benefit', 'Cost', 'Net benefit'],
      datasets: [
        {
          label: `Values (${cur})`,
          data: [derived.benefitMonetary || 0, derived.costTotal || 0, derived.netBenefit || 0],
          backgroundColor: ['#1f6feb', '#e5e7eb', '#00a3a3']
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${formatCurrency(ctx.parsed.y, cur)}`
          }
        }
      },
      scales: {
        y: {
          ticks: {
            callback: value => formatShortCurrency(value, cur)
          }
        }
      }
    }
  });

  const suppPctRaw = (derived.support || 0) * 100;
  const suppPct = parseFloat(suppPctRaw.toFixed(1));
  const optOutPct = parseFloat((100 - suppPct).toFixed(1));

  let supportColor = '#ef4444'; // red
  if (suppPct >= 70) {
    supportColor = '#059669'; // green
  } else if (suppPct >= 50) {
    supportColor = '#f59e0b'; // amber
  }

  supportChart = new Chart(ctxSupport, {
    type: 'bar',
    data: {
      labels: ['Support mandate', 'Prefer no mandate'],
      datasets: [
        {
          label: 'Share of population (%)',
          data: [suppPct, optOutPct],
          backgroundColor: [supportColor, '#e5e7eb']
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y.toFixed(1)}%`
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: {
            callback: value => `${value}%`
          }
        }
      }
    }
  });
}

/* =========================================================
   Scenarios & exports
   ========================================================= */

function isIncompleteScenario(s) {
  const d = s.derived;
  const set = s.settings;
  if (!d || !set) return true;
  return !set.vslValue || set.vslValue <= 0 || !d.costTotal || d.costTotal <= 0;
}

function saveScenario() {
  if (!state.config || !state.derived) {
    showToast('Please apply a configuration before saving a scenario.', 'warning');
    return;
  }

  const s = {
    id: state.scenarios.length + 1,
    timestamp: new Date().toISOString(),
    settings: { ...state.settings },
    config: { ...state.config },
    costs: state.costs ? { ...state.costs } : null,
    derived: { ...state.derived },
    pinned: false,
    notes: ''
  };

  state.scenarios.push(s);
  saveToStorage();
  rebuildScenariosTable();
  populateScenarioBriefing(s);
  showToast('Scenario saved.', 'success');
}

function rebuildScenariosTable() {
  const tbody = document.querySelector('#scenarios-table tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!state.scenarios.length) {
    rebuildPinnedTable();
    return;
  }

  state.scenarios.forEach((s, idx) => {
    const tr = document.createElement('tr');

    const d = s.derived;
    const c = s.config;
    const cur = s.settings.currencyLabel;

    const cells = [
      idx + 1,
      countryLabel(c.country),
      outbreakLabel(c.outbreak),
      scopeLabel(c.scope),
      exemptionsLabel(c.exemptions),
      coverageLabel(c.coverage),
      c.livesPer100k.toFixed(1),
      d ? d.livesTotal.toFixed(1) : '–',
      d ? formatShortCurrency(d.benefitMonetary, cur) : '–',
      d ? (d.costTotal > 0 ? formatShortCurrency(d.costTotal, cur) : '–') : '–',
      d ? formatShortCurrency(d.netBenefit, cur) : '–',
      d && d.bcr != null ? d.bcr.toFixed(2) : '–',
      d ? formatPercent((d.support || 0) * 100) : '–'
    ];

    cells.forEach(val => {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    });

    // Pin checkbox cell
    const tdPin = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!s.pinned;
    checkbox.addEventListener('click', e => {
      e.stopPropagation();
      handlePinToggle(s.id, checkbox);
    });
    tdPin.appendChild(checkbox);
    tr.appendChild(tdPin);

    if (isIncompleteScenario(s)) {
      tr.classList.add('scenario-incomplete');
      tr.title = 'Costs and/or value per life saved are missing; BCR is not fully defined.';
    }

    tr.addEventListener('click', () => {
      populateScenarioBriefing(s);
    });

    tbody.appendChild(tr);
  });

  rebuildPinnedTable();
}

function handlePinToggle(scenarioId, checkboxEl) {
  const s = state.scenarios.find(sc => sc.id === scenarioId);
  if (!s) return;

  if (checkboxEl.checked) {
    const pinnedCount = state.scenarios.filter(sc => sc.pinned).length;
    if (pinnedCount >= 3) {
      checkboxEl.checked = false;
      showToast('You can pin at most three scenarios.', 'warning');
      return;
    }
    s.pinned = true;
  } else {
    s.pinned = false;
  }

  saveToStorage();
  rebuildScenariosTable();
}

function rebuildPinnedTable() {
  const tbody = document.querySelector('#pinned-table tbody');
  const emptyMsg = document.getElementById('pinned-empty');
  if (!tbody) return;

  tbody.innerHTML = '';

  const pinned = state.scenarios.filter(s => s.pinned);
  if (!pinned.length) {
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }

  if (emptyMsg) emptyMsg.style.display = 'none';

  pinned.slice(0, 3).forEach(s => {
    const tr = document.createElement('tr');
    const c = s.config;
    const d = s.derived || {};
    const cur = s.settings.currencyLabel;

    const cells = [
      s.id,
      countryLabel(c.country),
      outbreakLabel(c.outbreak),
      scopeLabel(c.scope),
      exemptionsLabel(c.exemptions),
      coverageLabel(c.coverage),
      c.livesPer100k.toFixed(1),
      d.livesTotal ? d.livesTotal.toFixed(1) : '–',
      d.costTotal > 0 ? formatShortCurrency(d.costTotal, cur) : '–',
      formatShortCurrency(d.benefitMonetary || 0, cur),
      d.bcr != null ? d.bcr.toFixed(2) : '–',
      formatPercent((d.support || 0) * 100)
    ];

    cells.forEach(val => {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    });

    if (isIncompleteScenario(s)) {
      tr.classList.add('scenario-incomplete');
      tr.title = 'Costs and/or value per life saved are missing; BCR is not fully defined.';
    }

    tr.addEventListener('click', () => {
      populateScenarioBriefing(s);
    });

    tbody.appendChild(tr);
  });
}

function populateScenarioBriefing(scenario) {
  const txt = document.getElementById('scenario-briefing-text');
  if (!txt) return;
  const c = scenario.config;
  const d = scenario.derived;
  const cur = scenario.settings.currencyLabel;

  const supp = (d.support || 0) * 100;

  const text =
    `Country: ${countryLabel(c.country)}; outbreak scenario: ${outbreakLabel(c.outbreak)}.\n` +
    `Mandate scope: ${scopeLabel(c.scope)}; exemption policy: ${exemptionsLabel(
      c.exemptions
    )}; coverage threshold to lift mandate: ${coverageLabel(c.coverage)}.\n` +
    `Expected lives saved: ${c.livesPer100k.toFixed(
      1
    )} per 100,000 people, implying around ${d.livesTotal.toFixed(
      1
    )} lives saved in the exposed population.\n` +
    `Monetary benefit of lives saved (using the chosen value-per-life metric): ${formatCurrency(
      d.benefitMonetary,
      cur
    )}.\n` +
    `Total implementation cost (as entered): ${
      d.costTotal > 0 ? formatCurrency(d.costTotal, cur) : 'costs not entered'
    }, giving a net benefit of ${formatCurrency(
      d.netBenefit,
      cur
    )} and a benefit–cost ratio of ${d.bcr != null ? d.bcr.toFixed(2) : 'not defined'}.\n` +
    `Model-based predicted public support for this mandate is approximately ${formatPercent(supp)}.\n` +
    `Interpretation: This summary can be pasted into emails or briefing documents and should be read alongside qualitative, ethical and legal considerations that are not captured in the preference study or the simple economic valuation used here.`;

  txt.value = text;
  selectedScenarioId = scenario.id;
  updateNotesBox();
}

function updateScenarioBriefingCurrent() {
  const txt = document.getElementById('scenario-briefing-text');
  if (!txt) return;

  if (!state.config || !state.derived) {
    txt.value =
      'Once you apply a configuration (and optionally enter costs), this box will show a short, plain-language summary of the current scenario ready to copy into emails or reports.';
    return;
  }

  const c = state.config;
  const d = state.derived;
  const cur = state.settings.currencyLabel;
  const supp = (d.support || 0) * 100;

  const text =
    `Current configuration – ${countryLabel(c.country)}, ${outbreakLabel(c.outbreak)}.\n` +
    `Scope: ${scopeLabel(c.scope)}; exemptions: ${exemptionsLabel(c.exemptions)}; coverage threshold: ${coverageLabel(
      c.coverage
    )}.\n` +
    `Expected lives saved: ${c.livesPer100k.toFixed(
      1
    )} per 100,000 people (≈${d.livesTotal.toFixed(1)} lives saved in the exposed population).\n` +
    `Monetary value of lives saved: ${formatCurrency(d.benefitMonetary, cur)}.\n` +
    `Implementation cost (if entered): ${
      d.costTotal > 0 ? formatCurrency(d.costTotal, cur) : 'not yet entered'
    }; net benefit: ${formatCurrency(d.netBenefit, cur)}; BCR: ${
      d.bcr != null ? d.bcr.toFixed(2) : 'not defined'
    }.\n` +
    `Predicted public support: ${formatPercent(supp)}.\n` +
    `Use this text as a starting point and add context on feasibility, distributional impacts and ethical considerations.`;

  txt.value = text;
}

/* Notes box */

function updateNotesBox() {
  const el = document.getElementById('scenario-notes');
  if (!el) return;

  if (!selectedScenarioId) {
    el.value = '';
    el.placeholder =
      'Select a scenario from the table above to add notes or distributional context.';
    return;
  }

  const s = state.scenarios.find(sc => sc.id === selectedScenarioId);
  if (!s) {
    el.value = '';
    el.placeholder =
      'Select a scenario from the table above to add notes or distributional context.';
    return;
  }

  el.value = s.notes || '';
  el.placeholder =
    'Add notes or distributional context for this scenario (for example, which groups are most affected).';
}

/* Exports */

function exportScenarios(kind) {
  if (!state.scenarios.length) {
    showToast('No scenarios to export.', 'warning');
    return;
  }

  const header = [
    'id',
    'country',
    'outbreak',
    'scope',
    'exemptions',
    'coverage',
    'lives_per_100k',
    'lives_total',
    'benefit',
    'cost',
    'net_benefit',
    'bcr',
    'support',
    'currency',
    'notes',
    'timestamp'
  ];

  const rows = state.scenarios.map(s => {
    const c = s.config;
    const d = s.derived || {};
    const cur = s.settings.currencyLabel;
    return [
      s.id,
      countryLabel(c.country),
      outbreakLabel(c.outbreak),
      scopeLabel(c.scope),
      exemptionsLabel(c.exemptions),
      coverageLabel(c.coverage),
      c.livesPer100k,
      d.livesTotal || '',
      d.benefitMonetary || '',
      d.costTotal || '',
      d.netBenefit || '',
      d.bcr != null ? d.bcr : '',
      d.support || '',
      cur,
      s.notes || '',
      s.timestamp
    ];
  });

  const csvLines = [
    header.join(','),
    ...rows.map(r => r.map(v => (typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : v)).join(','))
  ];
  const csvContent = csvLines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

  if (kind === 'csv' || kind === 'excel') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = kind === 'excel' ? 'mandeval_scenarios.xlsx.csv' : 'mandeval_scenarios.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast(
      kind === 'excel'
        ? 'Scenarios exported as CSV (Excel-readable).'
        : 'Scenarios exported as CSV.',
      'success'
    );
    return;
  }

  if (kind === 'pdf') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mandeval_scenarios_summary.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Summary data exported as CSV for use in PDF/reporting tools.', 'success');
    return;
  }

  if (kind === 'word') {
    exportScenariosAsWord();
    return;
  }
}

function exportScenariosAsWord() {
  const title = 'MANDEVAL – Vaccine Mandate Scenario Briefings';
  const now = new Date().toLocaleString();

  let html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1f2933; }
  h1 { font-size: 16pt; margin-bottom: 4pt; }
  h2 { font-size: 13pt; margin-top: 12pt; margin-bottom: 4pt; }
  h3 { font-size: 11pt; margin-top: 8pt; margin-bottom: 3pt; }
  p { margin: 2pt 0; }
  ul { margin: 0 0 4pt 18pt; padding: 0; }
  li { margin: 0 0 2pt 0; }
  .meta { font-size: 9pt; color: #6b7280; margin-bottom: 8pt; }
  .section { margin-bottom: 10pt; }
  .label { font-weight: bold; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">Generated on ${escapeHtml(
    now
  )}. Each scenario is based on mixed logit preference estimates and user-entered settings in the MANDEVAL tool.</p>
`;

  state.scenarios.forEach(s => {
    const c = s.config;
    const d = s.derived || {};
    const set = s.settings || state.settings;
    const cur = set.currencyLabel;
    const supp = (d.support || 0) * 100;

    html += `<div class="section">`;
    html += `<h2>Scenario ${s.id}: ${escapeHtml(countryLabel(c.country))} – ${escapeHtml(
      outbreakLabel(c.outbreak)
    )}</h2>`;
    html += `<p><span class="label">Time stamp:</span> ${escapeHtml(s.timestamp)}</p>`;

    html += `<h3>Mandate configuration</h3><ul>`;
    html += `<li><span class="label">Scope:</span> ${escapeHtml(scopeLabel(c.scope))}</li>`;
    html += `<li><span class="label">Exemptions:</span> ${escapeHtml(exemptionsLabel(c.exemptions))}</li>`;
    html += `<li><span class="label">Coverage requirement to lift mandate:</span> ${escapeHtml(
      coverageLabel(c.coverage)
    )}</li>`;
    html += `<li><span class="label">Expected lives saved:</span> ${c.livesPer100k.toFixed(
      1
    )} per 100,000 people</li>`;
    html += `<li><span class="label">Population covered:</span> ${set.population.toLocaleString()} people</li>`;
    html += `</ul>`;

    html += `<h3>Epidemiological benefit and monetary valuation</h3><ul>`;
    html += `<li><span class="label">Total lives saved (approx.):</span> ${
      d.livesTotal ? d.livesTotal.toFixed(1) : '–'
    } lives</li>`;
    html += `<li><span class="label">Value per life saved:</span> ${formatCurrency(set.vslValue, cur)}</li>`;
    html += `<li><span class="label">Monetary benefit of lives saved:</span> ${formatCurrency(
      d.benefitMonetary || 0,
      cur
    )}</li>`;
    html += `</ul>`;

    html += `<h3>Costs and benefit–cost profile</h3><ul>`;
    html += `<li><span class="label">Total implementation cost (as entered):</span> ${formatCurrency(
      d.costTotal || 0,
      cur
    )}</li>`;
    html += `<li><span class="label">Net benefit (benefit − cost):</span> ${formatCurrency(
      d.netBenefit || 0,
      cur
    )}</li>`;
    html += `<li><span class="label">Benefit–cost ratio (BCR):</span> ${
      d.bcr != null ? d.bcr.toFixed(2) : 'not defined'
    }</li>`;
    html += `</ul>`;

    html += `<h3>Model-based public support</h3><ul>`;
    html += `<li><span class="label">Predicted public support:</span> ${formatPercent(supp)}</li>`;
    html += `</ul>`;

    html += `<h3>Interpretation (for policy discussion)</h3>`;
    html += `<p>This scenario combines the model-based estimate of public support with a simple valuation of lives saved and indicative implementation costs. `;
    html += `Predicted support of ${formatPercent(
      supp
    )} should be interpreted as an indicative acceptance level under the stated outbreak scenario and mandate design, not as a forecast. `;
    html += `Net benefit and the benefit–cost ratio summarise the trade-off between epidemiological benefit and implementation cost, but do not capture important `;
    html += `ethical, legal, distributional or political considerations. These figures should therefore be read alongside qualitative judgements and stakeholder input.</p>`;

    if (s.notes && s.notes.trim()) {
      html += `<h3>Notes and distributional context (from user)</h3>`;
      html += `<p>${escapeHtml(s.notes)}</p>`;
    }

    html += `</div>`;
  });

  html += `<p class="meta">Note: All figures depend on the assumptions entered into MANDEVAL (population, value per life saved, cost inputs). For formal regulatory appraisal, the underlying data and assumptions should be checked and documented in a technical annex.</p>`;
  html += `</body></html>`;

  const blobDoc = new Blob([html], {
    type: 'application/msword;charset=utf-8;'
  });
  const url = URL.createObjectURL(blobDoc);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mandeval_scenarios_briefing.doc';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Word briefing downloaded (ready to print or edit).', 'success');
}

/* =========================================================
   Briefing & AI prompt
   ========================================================= */

function updateBriefingTemplate() {
  const el = document.getElementById('briefing-template');
  if (!el) return;

  if (!state.config || !state.derived) {
    el.value =
      'Apply a configuration and enter costs to auto-populate a briefing template based on the current scenario.';
    return;
  }

  const c = state.config;
  const d = state.derived;
  const s = state.settings;
  const supp = (d.support || 0) * 100;
  const cur = s.currencyLabel;

  const text =
    `Purpose\n` +
    `Summarise the expected public support, epidemiological benefits and indicative economic value of a specific COVID-19 vaccine mandate configuration in ${countryLabel(
      c.country
    )} under a ${outbreakLabel(c.outbreak).toLowerCase()} scenario.\n\n` +
    `Mandate configuration\n` +
    `• Country: ${countryLabel(c.country)}\n` +
    `• Outbreak scenario: ${outbreakLabel(c.outbreak)}\n` +
    `• Mandate scope: ${scopeLabel(c.scope)}\n` +
    `• Exemption policy: ${exemptionsLabel(c.exemptions)}\n` +
    `• Coverage requirement to lift mandate: ${coverageLabel(c.coverage)}\n` +
    `• Expected lives saved: ${c.livesPer100k.toFixed(1)} per 100,000 people\n\n` +
    `Epidemiological benefit and monetary valuation\n` +
    `• Exposed population: ${s.population.toLocaleString()} people\n` +
    `• Total lives saved (model input × population): ${d.livesTotal.toFixed(1)}\n` +
    `• Value per life saved (VSL or related metric): ${formatCurrency(s.vslValue, cur)}\n` +
    `• Monetary value of lives saved: ${formatCurrency(d.benefitMonetary, cur)}\n\n` +
    `Costs and benefit–cost profile\n` +
    `• Total implementation cost (as entered): ${formatCurrency(d.costTotal, cur)}\n` +
    `• Net benefit (benefit − cost): ${formatCurrency(d.netBenefit, cur)}\n` +
    `• Benefit–cost ratio (BCR): ${d.bcr != null ? d.bcr.toFixed(2) : 'not defined'}\n\n` +
    `Model-based public support\n` +
    `• Predicted public support for this mandate configuration: ${formatPercent(
      supp
    )}\n\n` +
    `Interpretation (to be tailored)\n` +
    `This configuration appears to offer ${
      d.bcr != null && d.bcr >= 1 ? 'a favourable' : 'an uncertain'
    } balance between epidemiological benefit and implementation cost, with predicted public support at around ${formatPercent(
      supp
    )}. These results should be interpreted alongside distributional, ethical and legal considerations that are not captured in the preference study or the simple economic valuation used here.`;

  el.value = text;
}

function updateAiPrompt() {
  const el = document.getElementById('ai-prompt');
  if (!el) return;

  if (!state.config || !state.derived) {
    el.value =
      'Apply a configuration and enter costs to auto-generate an AI prompt for Copilot or ChatGPT based on the current scenario.';
    return;
  }

  const c = state.config;
  const d = state.derived;
  const s = state.settings;
  const supp = (d.support || 0) * 100;
  const cur = s.currencyLabel;

  const prompt =
    `You are helping a public health policy team design a COVID-19 vaccine mandate.\n\n` +
    `CURRENT MANDATE CONFIGURATION\n` +
    `- Country: ${countryLabel(c.country)}\n` +
    `- Outbreak scenario: ${outbreakLabel(c.outbreak)}\n` +
    `- Scope: ${scopeLabel(c.scope)}\n` +
    `- Exemption policy: ${exemptionsLabel(c.exemptions)}\n` +
    `- Coverage threshold to lift mandate: ${coverageLabel(c.coverage)}\n` +
    `- Expected lives saved: ${c.livesPer100k.toFixed(1)} per 100,000 people\n\n` +
    `SETTINGS\n` +
    `- Analysis horizon: ${s.horizonYears} year(s)\n` +
    `- Population covered: ${s.population.toLocaleString()} people\n` +
    `- Currency label: ${cur}\n` +
    `- Value per life saved (VSL or related metric): ${formatCurrency(s.vslValue, cur)}\n\n` +
    `COST–BENEFIT SUMMARY FOR CURRENT CONFIGURATION\n` +
    `- Total implementation cost: ${formatCurrency(d.costTotal, cur)}\n` +
    `- Estimated total lives saved: ${d.livesTotal.toFixed(1)}\n` +
    `- Monetary benefit of lives saved: ${formatCurrency(d.benefitMonetary, cur)}\n` +
    `- Net benefit: ${formatCurrency(d.netBenefit, cur)}\n` +
    `- Benefit–cost ratio (BCR): ${d.bcr != null ? d.bcr.toFixed(2) : 'not defined'}\n` +
    `- Predicted public support (from mixed logit model): ${formatPercent(supp)}\n\n` +
    `TASK FOR YOU:\n` +
    `Draft a short, neutral and clear policy briefing that:\n` +
    `1. Summarises this mandate option in plain language.\n` +
    `2. Highlights the trade-offs between public health impact, costs and public support.\n` +
    `3. Flags key uncertainties or assumptions, including those related to epidemiological inputs, costs and the value per life saved.\n` +
    `4. Suggests up to three points for ministers or senior officials to consider when comparing this option with alternatives.\n` +
    `5. Briefly comment on any potential distributional concerns (for example, which groups might be most affected), even if these are only described qualitatively.\n\n` +
    `Use British spelling and keep the tone suitable for a government briefing.`;

  el.value = prompt;
}

/* =========================================================
   Reference designs
   ========================================================= */

function loadReferenceConfig(country) {
  const countrySelect = document.getElementById('cfg-country');
  const outbreakSelect = document.getElementById('cfg-outbreak');
  const scopeSelect = document.getElementById('cfg-scope');
  const exSelect = document.getElementById('cfg-exemptions');
  const covSelect = document.getElementById('cfg-coverage');
  const livesSlider = document.getElementById('cfg-lives');

  if (!countrySelect || !outbreakSelect || !scopeSelect || !exSelect || !covSelect || !livesSlider) return;

  let livesVal = 25;
  let covVal = '0.7';
  let scopeVal = 'highrisk';
  let exVal = 'medical';
  let outbreakVal = 'mild';

  if (country === 'AU') {
    livesVal = 25;
    covVal = '0.7';
    scopeVal = 'highrisk';
    exVal = 'medical';
    outbreakVal = 'mild';
  } else if (country === 'FR') {
    livesVal = 35;
    covVal = '0.9';
    scopeVal = 'all';
    exVal = 'medrel';
    outbreakVal = 'severe';
  } else if (country === 'IT') {
    livesVal = 25;
    covVal = '0.7';
    scopeVal = 'highrisk';
    exVal = 'medrel';
    outbreakVal = 'mild';
  }

  countrySelect.value = country;
  outbreakSelect.value = outbreakVal;
  scopeSelect.value = scopeVal;
  exSelect.value = exVal;
  covSelect.value = covVal;
  livesSlider.value = livesVal;

  const span = document.getElementById('cfg-lives-display');
  if (span) span.textContent = livesVal.toString();

  applyConfigFromForm();
  updateAll();
  showToast(`Reference design for ${countryLabel(country)} loaded. Adjust as needed.`, 'success');
}

/* =========================================================
   Toasts
   ========================================================= */

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';

  if (type === 'success') toast.classList.add('toast-success');
  else if (type === 'warning') toast.classList.add('toast-warning');
  else if (type === 'error') toast.classList.add('toast-error');

  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
    }, 500);
  }, 4500);
}

/* =========================================================
   Formatting helpers
   ========================================================= */

function formatCurrency(value, currencyLabel) {
  const v = typeof value === 'number' ? value : 0;
  if (!isFinite(v)) return `${currencyLabel} ?`;
  const abs = Math.abs(v);
  let formatted;
  if (abs >= 1e9) {
    formatted = (v / 1e9).toFixed(2) + ' B';
  } else if (abs >= 1e6) {
    formatted = (v / 1e6).toFixed(2) + ' M';
  } else if (abs >= 1e3) {
    formatted = (v / 1e3).toFixed(1) + ' K';
  } else {
    formatted = v.toFixed(0);
  }
  return `${currencyLabel} ${formatted}`;
}

function formatShortCurrency(value, currencyLabel) {
  const v = typeof value === 'number' ? value : 0;
  const abs = Math.abs(v);
  if (!isFinite(v)) return '?';
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

function formatPercent(value) {
  if (value == null || !isFinite(value)) return '–';
  return `${value.toFixed(1)}%`;
}

function countryLabel(code) {
  if (code === 'AU') return 'Australia';
  if (code === 'FR') return 'France';
  if (code === 'IT') return 'Italy';
  return code || '–';
}

function outbreakLabel(code) {
  if (code === 'mild') return 'Mild / endemic';
  if (code === 'severe') return 'Severe outbreak';
  return code || '–';
}

function scopeLabel(code) {
  if (code === 'highrisk') return 'High-risk occupations only';
  if (code === 'all') return 'All occupations & public spaces';
  return code || '–';
}

function exemptionsLabel(code) {
  if (code === 'medical') return 'Medical only';
  if (code === 'medrel') return 'Medical + religious';
  if (code === 'medrelpers') return 'Medical + religious + personal belief';
  return code || '–';
}

function coverageLabel(val) {
  if (val === 0.5 || String(val) === '0.5') return '50% population vaccinated';
  if (val === 0.7 || String(val) === '0.7') return '70% population vaccinated';
  if (val === 0.9 || String(val) === '0.9') return '90% population vaccinated';
  return String(val);
}

function copyFromTextarea(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.value || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Text copied to clipboard.', 'success'),
      () => fallbackCopy(el)
    );
  } else {
    fallbackCopy(el);
  }
}

function fallbackCopy(el) {
  el.select();
  el.setSelectionRange(0, 99999);
  document.execCommand('copy');
  showToast('Text copied to clipboard.', 'success');
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
