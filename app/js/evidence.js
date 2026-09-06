/* LongevityOS — what has evidence in PEOPLE.
 *
 * The atlas says, truthfully, that no drug has ever been shown to extend human
 * lifespan. This ledger is the other half of that sentence: what randomised
 * trials and cohort studies HAVE found about deaths and major events in the
 * people they enrolled — and every rigorous null and every harm, on the same
 * footing.
 *
 * THE RULES OF THIS FILE (qa/unit.mjs, qa/content.mjs and qa/verify-sources.mjs
 * enforce them mechanically):
 *  1. Every row carries finding, design, outcome, effect, year, cite, url and a
 *     titleCheck. CI resolves every url against PubMed's E-utilities and fails
 *     the build on a title mismatch, so a wrong PMID is a red build.
 *  2. `effect` is the number AS REPORTED, with its interval. Where a number
 *     could not be confirmed against the record, the finding is described
 *     qualitatively — a number is never invented to fill the field.
 *  3. Nulls and harms are first-class rows; an item whose only rows are null or
 *     harm is exactly as welcome here as one that reduced deaths.
 *  4. Rungs are COMPUTED from (design, outcome) — never typed.
 *  5. Nothing in this file advises anyone to do anything. A result is a result
 *     in people like those in the trial; doses appear only as what a trial used.
 */

export const EVIDENCE_HEADLINE =
  "This ledger is not medical advice. It reports what randomised trials and cohort studies found " +
  "in the people they enrolled — including the things that did nothing and the things that did harm.";

export const EVIDENCE_NOTE =
  "Every result here is a result in people like those in the trial. A drug that reduced deaths in " +
  "hypertensive 60-year-olds says nothing about healthy 30-year-olds; a supplement that did nothing in " +
  "well-nourished physicians was never tested in people who were deficient. The 'who was studied' line " +
  "on each card is what the number means — without it, the number means nothing.";

export const EVIDENCE_RUNGS = [
  {
    key: "E3", label: "Randomised trial: fewer deaths",
    blurb: "A randomised trial, or a meta-analysis of randomised trials, reported lower all-cause mortality in the people it enrolled. The strongest evidence a human intervention can have."
  },
  {
    key: "E2", label: "Randomised trial: fewer major events",
    blurb: "Randomised evidence of fewer heart attacks, strokes or cancers — but not fewer deaths, or with mortality not the endpoint the trial was built to test."
  },
  {
    key: "E1", label: "Observational: fewer deaths",
    blurb: "Cohorts, pooled cohorts or non-randomised controlled studies found fewer deaths or events. Association, not proof: the people who did the thing differed from the people who did not."
  },
  {
    key: "E0", label: "Rigorous null or harm",
    blurb: "A well-run trial found nothing — or found harm. These rows are the point of the ledger, not its footnotes."
  }
];

export const KIND_LABEL = {
  behaviour: "behaviour", medical: "medical", diet: "diet",
  supplement: "supplement", environment: "environment", procedure: "procedure"
};

export const DESIGN_LABEL = {
  rct: "randomised trial", "meta-rct": "meta-analysis of randomised trials",
  cohort: "cohort study", "meta-cohort": "pooled cohorts", controlled: "controlled, non-randomised"
};

export const OUTCOME_LABEL = {
  mortality: "fewer deaths", events: "fewer major events", null: "no effect found", harm: "harm found"
};

const RCT_DESIGNS = ["rct", "meta-rct"];
const OBS_DESIGNS = ["cohort", "meta-cohort", "controlled"];

/* E3 if any randomised row reduced all-cause mortality; else E2 if any randomised
 * row reduced major events; else E1 if any observational row reduced deaths or
 * events; else E0 — the item's only human evidence is a null or a harm. */
export function strongestHuman(item) {
  const rows = item.rows || [];
  if (rows.some((r) => RCT_DESIGNS.includes(r.design) && r.outcome === "mortality")) return "E3";
  if (rows.some((r) => RCT_DESIGNS.includes(r.design) && r.outcome === "events")) return "E2";
  if (rows.some((r) => OBS_DESIGNS.includes(r.design) && (r.outcome === "mortality" || r.outcome === "events"))) return "E1";
  return "E0";
}

export function hasHumanNull(item) {
  return (item.rows || []).some((r) => r.outcome === "null" || r.outcome === "harm");
}

export function rungLabelHuman(key) {
  const r = EVIDENCE_RUNGS.find((x) => x.key === key);
  return r ? r.label : key;
}

/* kind:    behaviour | medical | diet | supplement | environment | procedure
 * design:  rct | meta-rct | cohort | meta-cohort | controlled
 * outcome: mortality | events | null | harm                                  */

export const HUMAN_EVIDENCE = [
  {
    id: "bloodpressure",
    name: "Treating high blood pressure",
    kind: "medical",
    what: "Drug treatment that lowers blood pressure, tested against placebo in people over 80 (HYVET) and as a lower target against a standard target in adults at raised risk (SPRINT).",
    who: "SPRINT: 9,361 adults aged 50 or older with systolic pressure 130–180, raised cardiovascular risk and no diabetes or prior stroke. HYVET: 3,845 adults aged 80 or older with sustained systolic pressure of 160 or more.",
    caveat: "Neither trial enrolled people with normal blood pressure, diabetes or a prior stroke, and the intensive target in SPRINT came with more fainting, electrolyte disturbances and acute kidney injury.",
    rows: [
      {
        finding: "Aiming for a systolic pressure below 120 instead of below 140 reduced death from any cause; the trial was stopped early for benefit after a median of 3.26 years.",
        design: "rct", outcome: "mortality",
        effect: "HR 0.73 (95% CI 0.60–0.90) for death from any cause",
        year: 2015,
        cite: "N Engl J Med 373:2103–2116 — SPRINT Research Group, Wright JT Jr et al. 2015",
        url: "https://pubmed.ncbi.nlm.nih.gov/26551272/",
        titleCheck: "A Randomized Trial of Intensive versus Standard Blood-Pressure Control"
      },
      {
        finding: "The final report, with extended follow-up and fully adjudicated events, held the result: death from any cause stayed lower in the intensive-target group.",
        design: "rct", outcome: "mortality",
        effect: "HR 0.75 (95% CI 0.61–0.92) for death from any cause; 1.06 vs 1.41 deaths per 100 person-years",
        year: 2021,
        cite: "N Engl J Med 384:1921–1930 — SPRINT Research Group, Lewis CE et al. 2021",
        url: "https://pubmed.ncbi.nlm.nih.gov/34010531/",
        titleCheck: "Final Report of a Trial of Intensive versus Standard Blood-Pressure Control"
      },
      {
        finding: "In people aged 80 or older, indapamide (with perindopril added if needed) against placebo reduced death from any cause as well as fatal stroke and heart failure; the trial was stopped early for benefit.",
        design: "rct", outcome: "mortality",
        effect: "21% reduction in death from any cause (95% CI 4–35; P=0.02)",
        year: 2008,
        cite: "N Engl J Med 358:1887–1898 — Beckett NS et al. (HYVET) 2008",
        url: "https://pubmed.ncbi.nlm.nih.gov/18378519/",
        titleCheck: "Treatment of hypertension in patients 80 years of age or older"
      }
    ]
  },

  {
    id: "statins",
    name: "Statins",
    kind: "medical",
    what: "Cholesterol-lowering drugs that block HMG-CoA reductase, pooled across every large randomised trial by the Cholesterol Treatment Trialists' Collaboration.",
    who: "About 170,000 adults in 26 randomised trials, most with existing vascular disease, diabetes or raised cardiovascular risk; a separate analysis covered people whose five-year risk of a major vascular event was below 10%.",
    caveat: "The mortality reduction is a per-millimole average across trials of people mostly at raised risk; in low-risk people the absolute benefit is small (about 11 fewer major vascular events per 1,000 over five years), and muscle symptoms and a small excess of new diabetes are reported.",
    rows: [
      {
        finding: "Across 26 randomised trials, each 1 mmol/L reduction in LDL cholesterol with statin therapy came with a 10% reduction in death from any cause, driven by fewer coronary deaths.",
        design: "meta-rct", outcome: "mortality",
        effect: "RR 0.90 (95% CI 0.87–0.93) for all-cause mortality per 1.0 mmol/L reduction in LDL cholesterol",
        year: 2010,
        cite: "Lancet 376:1670–1681 — Cholesterol Treatment Trialists' (CTT) Collaboration, Baigent C et al. 2010",
        url: "https://pubmed.ncbi.nlm.nih.gov/21067804/",
        titleCheck: "Efficacy and safety of more intensive lowering of LDL cholesterol"
      },
      {
        finding: "In people at low risk (five-year risk of a major vascular event below 10%), each 1 mmol/L reduction in LDL cholesterol still meant fewer major vascular events — a small absolute reduction of about 11 per 1,000 over five years.",
        design: "meta-rct", outcome: "events",
        effect: "about 11 fewer major vascular events per 1,000 people over five years per 1 mmol/L reduction in LDL cholesterol",
        year: 2012,
        cite: "Lancet 380:581–590 — Cholesterol Treatment Trialists' (CTT) Collaborators, Mihaylova B et al. 2012",
        url: "https://pubmed.ncbi.nlm.nih.gov/22607822/",
        titleCheck: "statin therapy in people at low risk of vascular disease"
      }
    ]
  },

  {
    id: "empagliflozin",
    name: "Empagliflozin (SGLT2 inhibitor)",
    kind: "medical",
    what: "A diabetes drug that makes the kidneys excrete glucose; EMPA-REG OUTCOME tested it against placebo on top of standard care.",
    who: "7,020 adults with type 2 diabetes AND established cardiovascular disease, followed for a median of 3.1 years.",
    caveat: "Every participant had diabetes plus existing cardiovascular disease; the trial says nothing about people without diabetes, and the drug class carries genital infections, volume depletion and rare ketoacidosis.",
    rows: [
      {
        finding: "Death from any cause was lower with empagliflozin than with placebo, alongside fewer cardiovascular deaths and fewer hospitalisations for heart failure.",
        design: "rct", outcome: "mortality",
        effect: "death from any cause 5.7% vs 8.3% — a 32% relative risk reduction",
        year: 2015,
        cite: "N Engl J Med 373:2117–2128 — Zinman B et al. (EMPA-REG OUTCOME) 2015",
        url: "https://pubmed.ncbi.nlm.nih.gov/26378978/",
        titleCheck: "Empagliflozin, Cardiovascular Outcomes, and Mortality in Type 2 Diabetes"
      }
    ]
  },

  {
    id: "semaglutide",
    name: "Semaglutide (GLP-1 receptor agonist)",
    kind: "medical",
    what: "A weekly injectable GLP-1 receptor agonist used for weight loss; the SELECT trial used 2.4 mg once a week against placebo.",
    who: "17,604 adults aged 45 or older with a body-mass index of 27 or more and pre-existing cardiovascular disease, but no diabetes, followed for a mean of 39.8 months.",
    caveat: "Death from cardiovascular causes did not reach significance in the trial's hierarchical testing, so the lower all-cause death count was never formally tested and is not counted here; gastrointestinal adverse events led more people to stop the drug.",
    rows: [
      {
        finding: "Major adverse cardiovascular events — cardiovascular death, non-fatal heart attack or non-fatal stroke — were fewer with semaglutide; cardiovascular death on its own did not reach significance, which stopped the confirmatory testing sequence.",
        design: "rct", outcome: "events",
        effect: "HR 0.80 (95% CI 0.72–0.90) for the composite of cardiovascular death, non-fatal myocardial infarction or non-fatal stroke (6.5% vs 8.0%); cardiovascular death HR 0.85 (95% CI 0.71–1.01; P=0.07)",
        year: 2023,
        cite: "N Engl J Med 389:2221–2232 — Lincoff AM et al. (SELECT) 2023",
        url: "https://pubmed.ncbi.nlm.nih.gov/37952131/",
        titleCheck: "Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes"
      }
    ]
  },

  {
    id: "saltsubstitute",
    name: "Potassium-enriched salt substitute",
    kind: "diet",
    what: "Replacing ordinary salt with a substitute that is 75% sodium chloride and 25% potassium chloride, tested in a cluster-randomised trial of 600 villages.",
    who: "Adults in 600 villages in rural China who had a history of stroke or were 60 or older with high blood pressure, followed for nearly five years.",
    caveat: "The population was rural Chinese with very high sodium intake and low potassium intake; people with serious kidney disease or on potassium-sparing drugs, for whom extra potassium can be dangerous, were excluded.",
    rows: [
      {
        finding: "Villages assigned the salt substitute had fewer strokes, fewer major cardiovascular events and fewer deaths from any cause than villages using regular salt.",
        design: "rct", outcome: "mortality",
        effect: "rate ratio 0.88 (95% CI 0.82–0.95) for death from any cause (39.28 vs 44.61 per 1,000 person-years); stroke rate ratio 0.86 (95% CI 0.77–0.96)",
        year: 2021,
        cite: "N Engl J Med 385:1067–1077 — Neal B et al. (SSaSS) 2021",
        url: "https://pubmed.ncbi.nlm.nih.gov/34459569/",
        titleCheck: "Effect of Salt Substitution on Cardiovascular Events and Death"
      }
    ]
  },

  {
    id: "metforminukpds",
    name: "Metformin in overweight people with new type 2 diabetes",
    kind: "medical",
    what: "The biguanide diabetes drug, assigned as first-line intensive glucose control against a diet-only policy in the UK Prospective Diabetes Study.",
    who: "Overweight adults (mean age 53) with newly diagnosed type 2 diabetes: 342 assigned to metformin against 411 on the conventional diet policy, followed for a median of 10.7 years.",
    caveat: "This is a diabetes result in a small randomised subgroup; it says nothing about people without diabetes, the atlas records that metformin alone failed the mouse ITP, and the TAME trial that would test it in non-diabetics has not run.",
    rows: [
      {
        finding: "Overweight patients allocated metformin had fewer diabetes-related endpoints and fewer deaths from any cause than those on the conventional diet policy.",
        design: "rct", outcome: "mortality",
        effect: "36% risk reduction for all-cause mortality (95% CI 9–55; P=0.011)",
        year: 1998,
        cite: "Lancet 352:854–865 — UK Prospective Diabetes Study (UKPDS) Group, UKPDS 34, 1998",
        url: "https://pubmed.ncbi.nlm.nih.gov/9742977/",
        titleCheck: "metformin on complications in overweight patients with type 2 diabetes"
      },
      {
        finding: "Ten years after the trial ended, the metformin group's lower death rate persisted even though glucose control had converged between the groups.",
        design: "rct", outcome: "mortality",
        effect: "27% risk reduction for death from any cause (P=0.002) in the metformin group at 10-year post-trial follow-up",
        year: 2008,
        cite: "N Engl J Med 359:1577–1589 — Holman RR et al. (UKPDS 80) 2008",
        url: "https://pubmed.ncbi.nlm.nih.gov/18784090/",
        titleCheck: "10-year follow-up of intensive glucose control in type 2 diabetes"
      }
    ]
  },

  {
    id: "intensiveglucose",
    name: "Intensive glucose lowering (HbA1c below 6%)",
    kind: "medical",
    what: "Pushing blood glucose toward normal (glycated haemoglobin below 6.0%) with intensified multi-drug regimens, tested against standard targets in ACCORD.",
    who: "10,251 adults with type 2 diabetes and either cardiovascular disease or additional cardiovascular risk factors, median age 62.",
    caveat: "The harm was seen with an aggressive multi-drug strategy in high-risk diabetics; it does not mean glucose control is harmful in general — the trial's own standard-target arm is the comparison.",
    rows: [
      {
        finding: "The intensive arm was stopped after 3.5 years because more people died on it; major cardiovascular events were not significantly reduced.",
        design: "rct", outcome: "harm",
        effect: "HR 1.22 (95% CI 1.01–1.46; P=0.04) for death from any cause (257 vs 203 deaths)",
        year: 2008,
        cite: "N Engl J Med 358:2545–2559 — Action to Control Cardiovascular Risk in Diabetes (ACCORD) Study Group, Gerstein HC et al. 2008",
        url: "https://pubmed.ncbi.nlm.nih.gov/18539917/",
        titleCheck: "Effects of intensive glucose lowering in type 2 diabetes"
      }
    ]
  },

  {
    id: "smokingcessation",
    name: "Stopping smoking",
    kind: "behaviour",
    what: "Quitting cigarettes, observed across fifty years in a cohort of British doctors whose smoking habits were recorded from 1951 onward.",
    who: "34,439 male British doctors born between 1900 and 1930, followed for cause-specific mortality for 50 years.",
    caveat: "No one was randomised to quit; the cohort is male doctors of one century and one country, and the gain depends on how long a person smoked before stopping.",
    rows: [
      {
        finding: "Men who kept smoking cigarettes died about ten years younger than lifelong non-smokers; stopping at 60, 50, 40 or 30 gained about 3, 6, 9 or 10 years of life expectancy.",
        design: "cohort", outcome: "mortality",
        effect: "continuing smokers died about 10 years younger than never-smokers; cessation at 60, 50, 40 or 30 gained about 3, 6, 9 or 10 years of life expectancy",
        year: 2004,
        cite: "BMJ 328:1519 — Doll R, Peto R, Boreham J, Sutherland I 2004",
        url: "https://pubmed.ncbi.nlm.nih.gov/15213107/",
        titleCheck: "50 years' observations on male British doctors"
      }
    ]
  },

  {
    id: "exercise",
    name: "Physical activity",
    kind: "behaviour",
    what: "Leisure-time physical activity, from any at all up to several times the guideline minimum of 7.5 MET-hours a week.",
    who: "Cohorts: 661,137 adults (median age 62) in six pooled US and European cohorts who reported their own activity, followed for a median of 14.2 years. Trial: Norwegian adults aged 70–77 randomised to five years of supervised exercise or to standard activity advice.",
    caveat: "The large mortality gradient is observational and self-reported — healthier people move more — and the one five-year randomised trial in older adults found no significant difference in deaths against a control group that was itself active.",
    rows: [
      {
        finding: "Compared with no leisure-time activity, any activity below the guideline minimum was associated with 20% lower mortality; 1–2, 2–3 and 3–5 times the minimum were associated with 31%, 37% and 39% lower mortality.",
        design: "meta-cohort", outcome: "mortality",
        effect: "HR 0.80 (95% CI 0.78–0.82) for less than 7.5 MET-hours a week vs none; 31%, 37% and 39% lower mortality at 1–2, 2–3 and 3–5 times the guideline minimum",
        year: 2015,
        cite: "JAMA Intern Med 175:959–967 — Arem H et al. 2015",
        url: "https://pubmed.ncbi.nlm.nih.gov/25844730/",
        titleCheck: "Leisure time physical activity and mortality"
      },
      {
        finding: "Five years of supervised high-intensity or moderate exercise did not significantly reduce all-cause mortality compared with following national activity guidelines.",
        design: "rct", outcome: "null",
        effect: "all-cause mortality 4.5% (combined exercise groups) vs 4.7% (control); high-intensity training HR 0.63 (95% CI 0.33–1.20), moderate training HR 1.24 (95% CI 0.73–2.10)",
        year: 2020,
        cite: "BMJ 371:m3485 — Stensvold D et al. (Generation 100) 2020",
        url: "https://pubmed.ncbi.nlm.nih.gov/33028588/",
        titleCheck: "Effect of exercise training for five years on all cause mortality in older adults"
      }
    ]
  },

  {
    id: "colonoscopy",
    name: "Colonoscopy screening",
    kind: "procedure",
    what: "A single invitation to a screening colonoscopy, tested against no invitation in the NordICC trial.",
    who: "84,585 adults aged 55–64 in Poland, Norway and Sweden, followed for a median of 10 years; only 42% of those invited actually had the colonoscopy.",
    caveat: "The intention-to-screen result is diluted by the 58% who declined; per-protocol estimates were larger but are not randomised comparisons, and neither analysis found fewer deaths from any cause.",
    rows: [
      {
        finding: "Invitation to colonoscopy lowered the ten-year risk of colorectal cancer by 18% in the intention-to-screen analysis.",
        design: "rct", outcome: "events",
        effect: "risk ratio 0.82 (95% CI 0.70–0.93) for colorectal cancer at 10 years",
        year: 2022,
        cite: "N Engl J Med 387:1547–1556 — Bretthauer M et al. (NordICC) 2022",
        url: "https://pubmed.ncbi.nlm.nih.gov/36214590/",
        titleCheck: "Effect of Colonoscopy Screening on Risks of Colorectal Cancer and Related Death"
      },
      {
        finding: "Death from colorectal cancer was not significantly reduced, and death from any cause was identical between the invited and usual-care groups.",
        design: "rct", outcome: "null",
        effect: "colorectal-cancer death 0.28% vs 0.31% (risk ratio 0.90, 95% CI 0.64–1.16); death from any cause 11.03% vs 11.04% (risk ratio 0.99, 95% CI 0.96–1.04)",
        year: 2022,
        cite: "N Engl J Med 387:1547–1556 — Bretthauer M et al. (NordICC) 2022",
        url: "https://pubmed.ncbi.nlm.nih.gov/36214590/",
        titleCheck: "Effect of Colonoscopy Screening on Risks of Colorectal Cancer and Related Death"
      }
    ]
  },

  {
    id: "mediterranean",
    name: "Mediterranean diet",
    kind: "diet",
    what: "A Mediterranean dietary pattern supplemented with extra-virgin olive oil or mixed nuts, compared with advice to reduce dietary fat, in the PREDIMED trial.",
    who: "Spanish adults aged 55–80 at high cardiovascular risk (type 2 diabetes or three or more risk factors) but without cardiovascular disease at entry.",
    caveat: "The original 2013 paper was retracted after randomisation irregularities at some sites and re-analysed; the endpoint is a composite of cardiovascular events rather than death from any cause, and the control was low-fat advice rather than a typical Western diet.",
    rows: [
      {
        finding: "Major cardiovascular events — heart attack, stroke or cardiovascular death — were fewer on both Mediterranean diets than on the low-fat control diet.",
        design: "rct", outcome: "events",
        effect: "HR 0.69 (95% CI 0.53–0.91) with extra-virgin olive oil and HR 0.72 (95% CI 0.54–0.95) with nuts, versus the control diet",
        year: 2018,
        cite: "N Engl J Med 378:e34 — Estruch R et al. (PREDIMED, republished) 2018",
        url: "https://pubmed.ncbi.nlm.nih.gov/29897866/",
        titleCheck: "Mediterranean Diet Supplemented with Extra-Virgin Olive Oil or Nuts"
      }
    ]
  },

  {
    id: "polypill",
    name: "Polypill after a heart attack",
    kind: "medical",
    what: "A single pill combining aspirin, ramipril and atorvastatin, compared with the same drugs prescribed separately as usual care, in the SECURE trial.",
    who: "2,499 adults aged 65 or older who had a myocardial infarction within the previous six months, at 113 centres in seven European countries, followed for a median of three years.",
    caveat: "The comparison is a packaging-and-adherence strategy, not the drugs against nothing; every participant had already had a heart attack, and death from any cause was not the primary endpoint.",
    rows: [
      {
        finding: "Major adverse cardiovascular events were fewer with the polypill strategy than with usual care, with higher self-reported adherence.",
        design: "rct", outcome: "events",
        effect: "HR 0.76 (95% CI 0.60–0.96) for cardiovascular death, non-fatal myocardial infarction, non-fatal ischaemic stroke or urgent revascularisation",
        year: 2022,
        cite: "N Engl J Med 387:967–977 — Castellano JM et al. (SECURE) 2022",
        url: "https://pubmed.ncbi.nlm.nih.gov/36018037/",
        titleCheck: "Polypill Strategy in Secondary Cardiovascular Prevention"
      }
    ]
  },

  {
    id: "aspirinelderly",
    name: "Daily low-dose aspirin in healthy older adults",
    kind: "medical",
    what: "Aspirin for primary prevention in people with no cardiovascular disease; the ASPREE trial used 100 mg of enteric-coated aspirin a day against placebo.",
    who: "19,114 community-dwelling adults aged 70 or older (65 or older for US Black and Hispanic participants) with no cardiovascular disease, dementia or disability, followed for a median of 4.7 years.",
    caveat: "These are results in people who had never had a heart attack or stroke; ASPREE says nothing about aspirin for people who already have cardiovascular disease, where the evidence is a different question.",
    rows: [
      {
        finding: "Death from any cause was higher with aspirin than with placebo, driven mostly by cancer deaths.",
        design: "rct", outcome: "harm",
        effect: "HR 1.14 (95% CI 1.01–1.29) for death from any cause (12.7 vs 11.1 per 1,000 person-years); cancer death HR 1.31 (95% CI 1.10–1.56)",
        year: 2018,
        cite: "N Engl J Med 379:1519–1528 — McNeil JJ et al. (ASPREE) 2018",
        url: "https://pubmed.ncbi.nlm.nih.gov/30221595/",
        titleCheck: "Effect of Aspirin on All-Cause Mortality in the Healthy Elderly"
      },
      {
        finding: "Major haemorrhage was significantly more frequent with aspirin, and cardiovascular events were not significantly reduced.",
        design: "rct", outcome: "harm",
        effect: "HR 1.38 (95% CI 1.18–1.62) for major haemorrhage (8.6 vs 6.2 per 1,000 person-years)",
        year: 2018,
        cite: "N Engl J Med 379:1509–1518 — McNeil JJ et al. (ASPREE) 2018",
        url: "https://pubmed.ncbi.nlm.nih.gov/30221597/",
        titleCheck: "Effect of Aspirin on Cardiovascular Events and Bleeding in the Healthy Elderly"
      },
      {
        finding: "The primary endpoint — survival free of dementia and persistent physical disability — was no better with aspirin than with placebo.",
        design: "rct", outcome: "null",
        effect: "21.5 vs 21.2 events per 1,000 person-years for death, dementia or persistent physical disability (P=0.79)",
        year: 2018,
        cite: "N Engl J Med 379:1499–1508 — McNeil JJ et al. (ASPREE) 2018",
        url: "https://pubmed.ncbi.nlm.nih.gov/30221596/",
        titleCheck: "Effect of Aspirin on Disability-free Survival in the Healthy Elderly"
      }
    ]
  },

  {
    id: "vitamind",
    name: "Vitamin D supplements",
    kind: "supplement",
    what: "Vitamin D3 as a supplement against placebo; the trials used 2,000 IU a day (VITAL) or 60,000 IU once a month (D-Health).",
    who: "VITAL: 25,871 US adults (men 50 or older, women 55 or older) not selected for low vitamin D. D-Health: 21,315 Australians aged 60–84, unscreened for deficiency.",
    caveat: "Both trials enrolled mostly people who were not vitamin D deficient; they do not test replacement in people with documented deficiency, and neither had a bone outcome as its primary endpoint.",
    rows: [
      {
        finding: "Vitamin D3 did not lower the incidence of invasive cancer or of major cardiovascular events over a median of 5.3 years.",
        design: "rct", outcome: "null",
        effect: "HR 0.96 (95% CI 0.88–1.06) for invasive cancer; HR 0.97 (95% CI 0.85–1.12) for major cardiovascular events",
        year: 2019,
        cite: "N Engl J Med 380:33–44 — Manson JE et al. (VITAL) 2019",
        url: "https://pubmed.ncbi.nlm.nih.gov/30415629/",
        titleCheck: "Vitamin D Supplements and Prevention of Cancer and Cardiovascular Disease"
      },
      {
        finding: "Monthly high-dose vitamin D3 for five years did not reduce all-cause mortality, the trial's primary outcome.",
        design: "rct", outcome: "null",
        effect: "no reduction in all-cause mortality — the confidence interval spanned a 7% reduction to an 18% increase; cancer mortality HR 1.15 (95% CI 0.96–1.39)",
        year: 2022,
        cite: "Lancet Diabetes Endocrinol 10:120–128 — Neale RE et al. (D-Health) 2022",
        url: "https://pubmed.ncbi.nlm.nih.gov/35026158/",
        titleCheck: "The D-Health Trial: a randomised controlled trial of the effect of vitamin D on mortality"
      }
    ]
  },

  {
    id: "omega3",
    name: "Omega-3 (fish oil) supplements",
    kind: "supplement",
    what: "Marine omega-3 fatty acids (EPA + DHA) as a capsule against placebo for primary prevention; both trials used 1 g a day.",
    who: "VITAL: 25,871 US adults (men 50 or older, women 55 or older) without cardiovascular disease or cancer. ASCEND: 15,480 adults with diabetes but no atherosclerotic cardiovascular disease, followed for a mean of 7.4 years.",
    caveat: "These are 1 g/day primary-prevention results; high-dose purified EPA in people with raised triglycerides (REDUCE-IT) is a different, contested question, and eating fish was not what these trials tested.",
    rows: [
      {
        finding: "Omega-3 capsules did not lower the incidence of major cardiovascular events or of invasive cancer over a median of 5.3 years.",
        design: "rct", outcome: "null",
        effect: "HR 0.92 (95% CI 0.80–1.06) for major cardiovascular events; HR 1.03 (95% CI 0.93–1.13) for invasive cancer",
        year: 2019,
        cite: "N Engl J Med 380:23–32 — Manson JE et al. (VITAL) 2019",
        url: "https://pubmed.ncbi.nlm.nih.gov/30415637/",
        titleCheck: "Marine n-3 Fatty Acids and Prevention of Cardiovascular Disease and Cancer"
      },
      {
        finding: "In people with diabetes, omega-3 capsules made no significant difference to serious vascular events over 7.4 years.",
        design: "rct", outcome: "null",
        effect: "rate ratio 0.97 (95% CI 0.87–1.08; P=0.55) for serious vascular events (8.9% vs 9.2%)",
        year: 2018,
        cite: "N Engl J Med 379:1540–1550 — ASCEND Study Collaborative Group, Bowman L et al. 2018",
        url: "https://pubmed.ncbi.nlm.nih.gov/30146932/",
        titleCheck: "Effects of n-3 Fatty Acid Supplements in Diabetes Mellitus"
      }
    ]
  },

  {
    id: "hormonetherapy",
    name: "Menopausal hormone therapy",
    kind: "medical",
    what: "Conjugated equine oestrogens, with or without medroxyprogesterone acetate, taken daily for 5–7 years against placebo in the Women's Health Initiative trials.",
    who: "27,347 postmenopausal women aged 50–79 at 40 US centres, most of them more than a decade past menopause at enrolment.",
    caveat: "These trials were not designed around symptom relief or around women starting therapy near menopause, and the 2002 harms were seen with one specific regimen; long-term mortality was neutral, not favourable.",
    rows: [
      {
        finding: "The oestrogen-plus-progestin trial was stopped early because risks exceeded benefits: more coronary heart disease, more stroke and more invasive breast cancer.",
        design: "rct", outcome: "harm",
        effect: "HR 1.29 (95% CI 1.02–1.63) for coronary heart disease; HR 1.41 (95% CI 1.07–1.85) for stroke; HR 1.26 (95% CI 1.00–1.59) for invasive breast cancer",
        year: 2002,
        cite: "JAMA 288:321–333 — Writing Group for the Women's Health Initiative Investigators, Rossouw JE et al. 2002",
        url: "https://pubmed.ncbi.nlm.nih.gov/12117397/",
        titleCheck: "Risks and benefits of estrogen plus progestin in healthy postmenopausal women"
      },
      {
        finding: "Over 18 years of cumulative follow-up, all-cause mortality was neither higher nor lower with hormone therapy than with placebo.",
        design: "rct", outcome: "null",
        effect: "HR 0.99 (95% CI 0.94–1.03) for all-cause mortality (27.1% vs 27.6%)",
        year: 2017,
        cite: "JAMA 318:927–938 — Manson JE et al. (WHI) 2017",
        url: "https://pubmed.ncbi.nlm.nih.gov/28898378/",
        titleCheck: "Menopausal Hormone Therapy and Long-term All-Cause and Cause-Specific Mortality"
      }
    ]
  },

  {
    id: "antioxidants",
    name: "Antioxidant supplements (beta-carotene, vitamins A and E)",
    kind: "supplement",
    what: "Beta-carotene, vitamin A, vitamin C, vitamin E and selenium as supplements, pooled across 78 randomised trials, plus the SELECT trial, which used 400 IU of vitamin E a day.",
    who: "296,707 participants in randomised trials, 215,900 of them healthy at enrolment; SELECT enrolled about 35,000 healthy men aged 50 or older.",
    caveat: "The harm signal comes from supplement doses well above dietary intake and is strongest for beta-carotene; vitamin C and selenium showed no mortality effect either way, and antioxidants eaten as food were not tested.",
    rows: [
      {
        finding: "In trials at low risk of bias, antioxidant supplements increased mortality; beta-carotene and vitamin E seem to increase mortality, and so may higher doses of vitamin A.",
        design: "meta-rct", outcome: "harm",
        effect: "beta-carotene RR 1.05 (95% CI 1.01–1.09) for mortality in low-risk-of-bias trials; no mortality effect found for vitamin C or selenium",
        year: 2012,
        cite: "Cochrane Database Syst Rev 2012(3):CD007176 — Bjelakovic G, Nikolova D, Gluud LL, Simonetti RG, Gluud C 2012",
        url: "https://pubmed.ncbi.nlm.nih.gov/22419320/",
        titleCheck: "Antioxidant supplements for prevention of mortality in healthy participants"
      },
      {
        finding: "Healthy men randomised to vitamin E developed more prostate cancers than men on placebo.",
        design: "rct", outcome: "harm",
        effect: "HR 1.17 (99% CI 1.004–1.36; P=0.008) for prostate cancer with vitamin E",
        year: 2011,
        cite: "JAMA 306:1549–1556 — Klein EA et al. (SELECT) 2011",
        url: "https://pubmed.ncbi.nlm.nih.gov/21990298/",
        titleCheck: "Vitamin E and the risk of prostate cancer"
      }
    ]
  },

  {
    id: "multivitamins",
    name: "Daily multivitamins",
    kind: "supplement",
    what: "A daily multivitamin-mineral tablet against placebo in the Physicians' Health Study II, and multivitamin use as recorded in three large US cohorts.",
    who: "PHS II: 14,641 male US physicians aged 50 or older, followed for a median of 11.2 years. Cohorts: 390,124 generally healthy US adults followed for more than 20 years.",
    caveat: "The cancer reduction was modest and borderline, in one trial of male physicians — a well-nourished group — while the same trial found no effect on cardiovascular events or deaths and the cohorts found no mortality benefit.",
    rows: [
      {
        finding: "Men assigned a daily multivitamin had a modest, borderline-significant reduction in total cancer incidence.",
        design: "rct", outcome: "events",
        effect: "HR 0.92 (95% CI 0.86–0.998; P=0.04) for total cancer",
        year: 2012,
        cite: "JAMA 308:1871–1880 — Gaziano JM et al. (Physicians' Health Study II) 2012",
        url: "https://pubmed.ncbi.nlm.nih.gov/23162860/",
        titleCheck: "Multivitamins in the prevention of cancer in men"
      },
      {
        finding: "The same trial found no significant effect on major cardiovascular events, cardiovascular death or all-cause mortality.",
        design: "rct", outcome: "null",
        effect: "no significant difference in major cardiovascular events, cardiovascular death or all-cause mortality",
        year: 2012,
        cite: "JAMA 308:1751–1760 — Sesso HD et al. (Physicians' Health Study II) 2012",
        url: "https://pubmed.ncbi.nlm.nih.gov/23117775/",
        titleCheck: "Multivitamins in the prevention of cardiovascular disease in men"
      },
      {
        finding: "Across three cohorts and more than 20 years, daily multivitamin users did not have lower mortality than non-users; in the early years of follow-up their mortality was slightly higher.",
        design: "cohort", outcome: "null",
        effect: "HR 1.04 (95% CI 1.02–1.07) for all-cause mortality among daily users in the first follow-up period; no benefit in later follow-up",
        year: 2024,
        cite: "JAMA Netw Open 7:e2418729 — Loftfield E et al. 2024",
        url: "https://pubmed.ncbi.nlm.nih.gov/38922615/",
        titleCheck: "Multivitamin Use and Mortality Risk in 3 Prospective US Cohorts"
      }
    ]
  },

  {
    id: "sleep",
    name: "Sleeping about seven to eight hours",
    kind: "behaviour",
    what: "Habitual sleep duration, as reported once at baseline in prospective cohort studies, compared across short, usual and long sleepers.",
    who: "More than 1.3 million adults in prospective cohort studies across Europe, Asia and the Americas, followed for at least three years.",
    caveat: "Sleep was self-reported once and nobody was assigned a sleep duration; long sleep in particular may be a marker of existing illness or depression rather than a cause of death, so this rung is association only.",
    rows: [
      {
        finding: "Both short and long sleep predicted death from any cause — a U-shaped association, with usual sleepers (about seven to eight hours) having the fewest deaths.",
        design: "meta-cohort", outcome: "mortality",
        effect: "both short and long duration of sleep were significant predictors of death from any cause",
        year: 2010,
        cite: "Sleep 33:585–592 — Cappuccio FP, D'Elia L, Strazzullo P, Miller MA 2010",
        url: "https://pubmed.ncbi.nlm.nih.gov/20469800/",
        titleCheck: "Sleep duration and all-cause mortality"
      }
    ]
  },

  {
    id: "socialties",
    name: "Strong social relationships",
    kind: "behaviour",
    what: "The strength of a person's social relationships — network size, integration, perceived support — measured at baseline and related to later survival.",
    who: "308,849 participants in 148 prospective studies, across many countries and many different measures of social relationships.",
    caveat: "Nobody was randomised to friendship; reverse causation (illness shrinks social life) and confounding are real, and the pooled odds ratio mixes many different measures of 'social relationships'.",
    rows: [
      {
        finding: "People with stronger social relationships had a 50% greater likelihood of survival over follow-up than those with weaker ties — an influence the authors judged comparable to established risk factors such as smoking.",
        design: "meta-cohort", outcome: "mortality",
        effect: "OR 1.50 (95% CI 1.42–1.59) for survival with stronger social relationships",
        year: 2010,
        cite: "PLoS Med 7:e1000316 — Holt-Lunstad J, Smith TB, Layton JB 2010",
        url: "https://pubmed.ncbi.nlm.nih.gov/20668659/",
        titleCheck: "Social relationships and mortality risk"
      }
    ]
  },

  {
    id: "alcohol",
    name: "Drinking less alcohol",
    kind: "diet",
    what: "Alcohol intake, from none through low-volume drinking to heavy drinking, as recorded in cohort studies and pooled in systematic analyses.",
    who: "GBD 2016: prospective and retrospective studies covering 195 countries and territories. Zhao 2023: 107 cohort studies of drinkers and lifetime non-drinkers.",
    caveat: "No randomised trial exists; the apparent protection from moderate drinking in older cohorts shrinks or vanishes once former drinkers and sick quitters are separated from lifelong abstainers, so the honest reading is no benefit, with harm rising with dose.",
    rows: [
      {
        finding: "Across all health outcomes, the risk of all-cause mortality and of cancers rose with increasing consumption; the level that minimised health loss was zero.",
        design: "meta-cohort", outcome: "mortality",
        effect: "the level of alcohol consumption that minimised harm across health outcomes was zero (95% UI 0.0–0.8) standard drinks per week",
        year: 2018,
        cite: "Lancet 392:1015–1035 — GBD 2016 Alcohol Collaborators 2018",
        url: "https://pubmed.ncbi.nlm.nih.gov/30146330/",
        titleCheck: "Alcohol use and burden for 195 countries and territories"
      },
      {
        finding: "After adjusting for study biases (former-drinker misclassification, age, cohort quality), low-volume drinkers had no significantly lower mortality than lifetime non-drinkers; risk rose at higher daily intakes.",
        design: "meta-cohort", outcome: "null",
        effect: "no significant reduction in all-cause mortality for low-volume drinkers vs lifetime non-drinkers after adjustment; significantly increased risk at higher daily intakes",
        year: 2023,
        cite: "JAMA Netw Open 6:e236185 — Zhao J, Stockwell T, Naimi T, Churchill S, Clay J, Sherk A 2023",
        url: "https://pubmed.ncbi.nlm.nih.gov/37000449/",
        titleCheck: "Association Between Daily Alcohol Intake and Risk of All-Cause Mortality"
      }
    ]
  },

  {
    id: "cleanair",
    name: "Cleaner air (less fine-particle pollution)",
    kind: "environment",
    what: "Long-term exposure to fine particulate air pollution (PM2.5), compared across cities and across periods when pollution fell.",
    who: "About 1.2 million US adults enrolled by the American Cancer Society in 1982 (Cancer Prevention Study II), and the adults of the Harvard Six Cities cohort followed as air quality improved.",
    caveat: "Exposure is assigned by city, not measured per person, and nobody was randomised to clean air; the Six Cities reduction analysis is the closest thing to an intervention, and it is still observational.",
    rows: [
      {
        finding: "Each 10 µg/m³ of long-term fine particulate pollution was associated with more deaths from all causes, from cardiopulmonary disease and from lung cancer.",
        design: "cohort", outcome: "mortality",
        effect: "about 4%, 6% and 8% higher all-cause, cardiopulmonary and lung-cancer mortality per 10 µg/m³ of PM2.5",
        year: 2002,
        cite: "JAMA 287:1132–1141 — Pope CA 3rd, Burnett RT, Thun MJ et al. 2002",
        url: "https://pubmed.ncbi.nlm.nih.gov/11879110/",
        titleCheck: "long-term exposure to fine particulate air pollution"
      },
      {
        finding: "When fine particulate levels fell between the two follow-up periods, mortality fell with them.",
        design: "cohort", outcome: "mortality",
        effect: "RR 0.73 (95% CI 0.57–0.95) for overall mortality per 10 µg/m³ decrease in mean PM2.5 between periods",
        year: 2006,
        cite: "Am J Respir Crit Care Med 173:667–672 — Laden F, Schwartz J, Speizer FE, Dockery DW 2006",
        url: "https://pubmed.ncbi.nlm.nih.gov/16424447/",
        titleCheck: "Reduction in fine particulate air pollution and mortality"
      }
    ]
  },

  {
    id: "bariatric",
    name: "Bariatric surgery for severe obesity",
    kind: "procedure",
    what: "Weight-loss surgery (gastric banding, vertical banded gastroplasty or gastric bypass) compared with conventional care in a matched, non-randomised controlled study.",
    who: "4,047 severely obese Swedish adults: 2,010 who chose surgery and 2,037 matched controls on conventional treatment, followed for an average of 10.9 years.",
    caveat: "Allocation was by choice, not randomisation, so healthier or more motivated people may have chosen surgery; the result applies to severe obesity and carries surgical mortality and complications of its own.",
    rows: [
      {
        finding: "Fewer deaths occurred in the surgery group than in the matched conventional-care group over an average of 10.9 years.",
        design: "controlled", outcome: "mortality",
        effect: "unadjusted HR 0.76 (P=0.04) for death from any cause; HR 0.71 (P=0.01) after adjustment for sex, age and risk factors",
        year: 2007,
        cite: "N Engl J Med 357:741–752 — Sjöström L et al. (Swedish Obese Subjects) 2007",
        url: "https://pubmed.ncbi.nlm.nih.gov/17715408/",
        titleCheck: "Effects of bariatric surgery on mortality in Swedish obese subjects"
      }
    ]
  },

  {
    id: "fluvaccine",
    name: "Influenza vaccination in older adults",
    kind: "medical",
    what: "Seasonal influenza vaccination, compared between vaccinated and unvaccinated seniors in health-plan cohorts across many seasons.",
    who: "713,872 person-seasons of community-dwelling adults aged 65 or older in US health-plan cohorts over ten seasons (Nichol); 72,527 adults aged 65 or older followed for eight years (Jackson).",
    caveat: "Vaccinated seniors are healthier to begin with: a cohort built to test this found their death rate was already 61% lower BEFORE each influenza season began, a gap the vaccine cannot explain, so cohort mortality estimates for this intervention are inflated by healthy-vaccinee bias.",
    rows: [
      {
        finding: "Across ten seasons, vaccination was associated with fewer hospitalisations for pneumonia or influenza and fewer deaths among community-dwelling seniors.",
        design: "cohort", outcome: "mortality",
        effect: "adjusted OR 0.73 for hospitalisation for pneumonia or influenza (a 27% reduction); the risk of death was also significantly lower among vaccinated persons",
        year: 2007,
        cite: "N Engl J Med 357:1373–1381 — Nichol KL, Nordin JD, Nelson DB, Mullooly JP, Hak E 2007",
        url: "https://pubmed.ncbi.nlm.nih.gov/17914038/",
        titleCheck: "Effectiveness of influenza vaccine in the community-dwelling elderly"
      },
      {
        finding: "Vaccinated seniors had a lower risk of death before the influenza season even started — evidence that healthier people get vaccinated, a bias the authors found large enough to account for the whole in-season association.",
        design: "cohort", outcome: "null",
        effect: "relative risk of death 0.39 (95% CI 0.33–0.47) before influenza season, 0.56 (95% CI 0.52–0.61) during and 0.74 (95% CI 0.67–0.80) after, vaccinated vs unvaccinated",
        year: 2006,
        cite: "Int J Epidemiol 35:337–344 — Jackson LA, Jackson ML, Nelson JC, Neuzil KM, Weiss NS 2006",
        url: "https://pubmed.ncbi.nlm.nih.gov/16368725/",
        titleCheck: "Evidence of bias in estimates of influenza vaccine effectiveness in seniors"
      }
    ]
  }
];
