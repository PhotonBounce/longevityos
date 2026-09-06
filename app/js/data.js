/* LongevityOS — the evidence corpus.
 *
 * THE RULES OF THIS FILE (qa/content.mjs enforces them mechanically):
 *  1. Every evidence row carries finding, organism, outcome, year, cite, url —
 *     and the url must point at an allowlisted primary source. The CI
 *     verify-sources workflow fetches every url and checks `titleCheck`
 *     against the page, so a wrong link is a red build, not a footnote.
 *  2. Nulls are first-class rows, never deleted, never buried. A compound
 *     that failed a rigorous test wears that failure on its card.
 *  3. No string in this file asserts that anything extends HUMAN lifespan,
 *     recommends a dose, or tells anyone to take anything. Findings state
 *     what a study reported, in that study's organism, and nothing more.
 */

export const HEADLINE =
  "No drug has ever been shown to extend human lifespan. " +
  "This atlas tracks the candidates people call immortality drugs — and the actual evidence, " +
  "including every rigorous failure.";

export const DISCLAIMER =
  "LongevityOS is a research atlas, not medical advice. It reports what published studies " +
  "found, in the organisms they studied. Doses mentioned are what a study used, not a " +
  "recommendation. Several compounds here are prescription drugs with real risks. " +
  "Decisions about any of them belong with you and a physician.";

/* organism: cell | worm | fly | mouse | rat | dog | monkey | human-obs | human-rct
 * outcome:  lifespan | healthspan | biomarker | safety | trial | null            */

export const COMPOUNDS = [
  {
    id: "rapamycin",
    name: "Rapamycin",
    aka: ["sirolimus"],
    klass: "mTOR inhibitor",
    what: "An FDA-approved transplant immunosuppressant that quiets the mTOR nutrient-sensing pathway — the single most reproducible lifespan drug in mammals.",
    humanStatus: "Approved for organ transplantation; longevity use is off-label and experimental. The PEARL trial (48 weeks) tested low weekly doses for safety and healthspan metrics.",
    risks: [
      "Immunosuppression at transplant doses; mouth ulcers, lipid changes and glucose intolerance reported at lower intermittent doses",
      "Human long-term risk/benefit at longevity dosing is unknown"
    ],
    itp: true,
    evidence: [
      {
        finding: "Fed from 600 days of age (a late start), rapamycin extended lifespan in both sexes; age at 90th-percentile survival rose ~14% in females and ~9% in males, replicated at three independent sites.",
        organism: "mouse", outcome: "lifespan", year: 2009,
        cite: "Harrison DE et al., Nature 460:392-395 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/19587680/",
        titleCheck: "Rapamycin fed late in life extends lifespan in genetically heterogeneous mice"
      },
      {
        finding: "48-week randomized placebo-controlled trial of 5 or 10 mg/week in 114 healthy adults (PEARL): treatment was generally well tolerated; modest lean-mass and self-reported well-being signals in some subgroups. No lifespan or aging endpoint was tested.",
        organism: "human-rct", outcome: "safety", year: 2025,
        cite: "Kaeberlein et al., Aging (PEARL trial results)",
        url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12074816/",
        titleCheck: "PEARL trial results"
      }
    ],
    verdict: "The strongest mammal evidence of any compound here — replicated, late-start, both sexes. In humans: early safety data only. Nobody has shown it extends a human life."
  },

  {
    id: "acarbose",
    name: "Acarbose",
    aka: [],
    klass: "α-glucosidase inhibitor (diabetes drug)",
    what: "A prescription diabetes drug that blunts post-meal glucose spikes by slowing starch digestion.",
    humanStatus: "Approved for type 2 diabetes. No human longevity trial.",
    risks: ["Gastrointestinal side effects (flatulence, diarrhea) are common"],
    itp: true,
    evidence: [
      {
        finding: "Increased male median lifespan by ~22% (females ~5%); 90th-percentile survival rose ~11% in males. Replicated across three ITP sites.",
        organism: "mouse", outcome: "lifespan", year: 2014,
        cite: "Harrison DE et al., Aging Cell 13:273-282 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/24245565/",
        titleCheck: "Acarbose, 17-α-estradiol, and nordihydroguaiaretic acid extend mouse lifespan preferentially in males"
      }
    ],
    verdict: "One of the ITP's clearest wins — but strongly male-biased in mice, and untested for longevity in people."
  },

  {
    id: "estradiol17a",
    name: "17α-Estradiol",
    aka: ["17aE2"],
    klass: "Non-feminizing estrogen isomer",
    what: "A weakly estrogenic stereoisomer of estradiol that extends male mouse lifespan without classic feminizing effects.",
    humanStatus: "Not an approved drug; research compound. No human longevity data.",
    risks: ["Human endocrine effects at longevity-style dosing are essentially uncharacterized"],
    itp: true,
    evidence: [
      {
        finding: "Increased male median lifespan by ~12%; no significant effect in females.",
        organism: "mouse", outcome: "lifespan", year: 2014,
        cite: "Harrison DE et al., Aging Cell 13:273-282 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/24245565/",
        titleCheck: "Acarbose, 17-α-estradiol, and nordihydroguaiaretic acid extend mouse lifespan preferentially in males"
      },
      {
        finding: "Started late in life (16 months), it still extended lifespan in male mice; the effect remains male-only.",
        organism: "mouse", outcome: "lifespan", year: 2021,
        cite: "Harrison DE et al., Aging Cell 20:e13328 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/33788371/",
        titleCheck: "17-a-estradiol late in life extends lifespan in aging UM-HET3 male mice"
      }
    ],
    verdict: "A reproducible male-only mouse result that doubles as a lesson: sex differences in aging biology are large, and mouse wins don't come pre-translated."
  },

  {
    id: "canagliflozin",
    name: "Canagliflozin",
    aka: [],
    klass: "SGLT2 inhibitor (diabetes drug)",
    what: "A prescription diabetes drug that makes the kidneys excrete glucose.",
    humanStatus: "Approved for type 2 diabetes. No human longevity trial.",
    risks: ["Genital/urinary infections, dehydration, rare ketoacidosis — real prescription-drug risks"],
    itp: true,
    evidence: [
      {
        finding: "Extended median survival of male mice by ~14% and 90th-percentile survival by ~9%, in parallel at three sites; no effect in females.",
        organism: "mouse", outcome: "lifespan", year: 2020,
        cite: "Miller RA et al., JCI Insight 5:e140019 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/32990681/",
        titleCheck: "Canagliflozin extends life span in genetically heterogeneous male but not female mice"
      }
    ],
    verdict: "Another male-only ITP win from the glucose-handling family — a pattern (with acarbose) that looks real and remains unexplained."
  },

  {
    id: "glycine",
    name: "Glycine",
    aka: [],
    klass: "Amino acid",
    what: "The simplest amino acid; abundant in collagen. Thought to act partly through methionine clearance.",
    humanStatus: "A common supplement. Human trials exist for sleep and metabolic markers, none for longevity.",
    risks: ["Generally well tolerated at studied intakes"],
    itp: true,
    evidence: [
      {
        finding: "Extended lifespan by a small but statistically significant 4-6% in BOTH male and female mice — one of the few ITP interventions to work in both sexes.",
        organism: "mouse", outcome: "lifespan", year: 2019,
        cite: "Miller RA et al., Aging Cell 18:e12953 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/30916479/",
        titleCheck: "Glycine supplementation extends lifespan of male and female mice"
      }
    ],
    verdict: "Small, real, both sexes, rigorously tested. A humble result that survived the gold-standard program many flashier compounds failed."
  },

  {
    id: "taurine",
    name: "Taurine",
    aka: [],
    klass: "Amino sulfonic acid",
    what: "A conditionally essential nutrient abundant in muscle; the 2023 Science paper proposed its age-related decline as a driver of aging.",
    humanStatus: "A supplement with long human use at modest doses. No human longevity outcome trial; the biomarker story is now contested.",
    risks: ["Well tolerated at commonly studied doses"],
    itp: false,
    evidence: [
      {
        finding: "Supplementation from middle age increased median lifespan (~10-12%) and healthspan measures in mice, and improved health markers in aged rhesus monkeys.",
        organism: "mouse", outcome: "lifespan", year: 2023,
        cite: "Singh P et al., Science 380:eabn9257",
        url: "https://www.science.org/doi/10.1126/science.abn9257",
        titleCheck: "Taurine deficiency as a driver of aging"
      },
      {
        finding: "Longitudinal human, primate and mouse cohorts found circulating taurine RISES or stays flat with age and tracks health outcomes inconsistently — evidence against taurine deficiency as a driver of human aging.",
        organism: "human-obs", outcome: "null", year: 2025,
        cite: "Aging Cell 24 (2025)",
        url: "https://onlinelibrary.wiley.com/doi/10.1111/acel.70191",
        titleCheck: "Experimental Evidence Against Taurine Deficiency as a Driver of Aging in Humans"
      },
      {
        finding: "NIA-led longitudinal analysis in Science reached the same verdict: taurine is unlikely to be a reliable biomarker of human aging.",
        organism: "human-obs", outcome: "null", year: 2025,
        cite: "Science (2025)",
        url: "https://www.science.org/doi/10.1126/science.adl2116",
        titleCheck: "taurine"
      }
    ],
    verdict: "A spectacular 2023 mouse result whose human premise took two direct hits in 2025. The mouse data stand; the 'your taurine is falling' story does not."
  },

  {
    id: "caakg",
    name: "Alpha-ketoglutarate",
    aka: ["CaAKG", "AKG"],
    klass: "Krebs-cycle metabolite",
    what: "An endogenous metabolite of energy metabolism, sold as a calcium salt supplement.",
    humanStatus: "Supplement. Human trials of biological-age markers are ongoing; no outcome data.",
    risks: ["Limited long-term human safety data at longevity-style dosing"],
    itp: false,
    evidence: [
      {
        finding: "Late-start dietary CaAKG increased survival and markedly reduced frailty in aging mice — morbidity was compressed even more than lifespan was extended.",
        organism: "mouse", outcome: "lifespan", year: 2020,
        cite: "Asadi Shahmirzadi A et al., Cell Metabolism 32:447-456",
        url: "https://pubmed.ncbi.nlm.nih.gov/32877690/",
        titleCheck: "Alpha-Ketoglutarate, an Endogenous Metabolite, Extends Lifespan and Compresses Morbidity in Aging Mice"
      }
    ],
    verdict: "A single strong mouse program with an attractive healthspan angle — awaiting independent replication and any human outcome."
  },

  {
    id: "spermidine",
    name: "Spermidine",
    aka: [],
    klass: "Polyamine (autophagy inducer)",
    what: "A natural polyamine (wheat germ, natto) that induces autophagy — the cell's recycling program.",
    humanStatus: "Supplement. The randomized SmartAge trial tested spermidine-rich supplementation for memory in older adults; human longevity outcomes are untested.",
    risks: ["Well tolerated in trials at dietary-range doses"],
    itp: false,
    evidence: [
      {
        finding: "Oral spermidine extended mouse lifespan and preserved cardiac function in old mice, via enhanced cardiac autophagy and mitophagy.",
        organism: "mouse", outcome: "lifespan", year: 2016,
        cite: "Eisenberg T et al., Nature Medicine 22:1428-1438",
        url: "https://pubmed.ncbi.nlm.nih.gov/27841876/",
        titleCheck: "Cardioprotection and lifespan extension by the natural polyamine spermidine"
      },
      {
        finding: "SmartAge: a registered randomized placebo-controlled trial of spermidine-rich plant extract for memory performance in older adults with subjective cognitive decline.",
        organism: "human-rct", outcome: "trial", year: 2021,
        cite: "ClinicalTrials.gov NCT03094546 (SmartAge)",
        url: "https://clinicaltrials.gov/study/NCT03094546",
        titleCheck: "Spermidine"
      }
    ],
    verdict: "Solid mouse cardiology-plus-lifespan data and honest, modest human trials. The gap between 'induces autophagy' and 'extends your life' remains uncrossed."
  },

  {
    id: "metformin",
    name: "Metformin",
    aka: [],
    klass: "Biguanide (diabetes drug)",
    what: "The world's most-prescribed diabetes drug and the longevity field's most argued-about molecule.",
    humanStatus: "Approved for type 2 diabetes. The proposed TAME trial would test it against clustered age-related disease in non-diabetics; it has not produced results.",
    risks: [
      "GI intolerance; rare lactic acidosis in renal impairment",
      "Some trials suggest it can blunt exercise-training adaptations"
    ],
    itp: true,
    evidence: [
      {
        finding: "0.1% dietary metformin from middle age modestly extended male mouse lifespan (~5% median) in an NIA study; a 10x higher dose was toxic.",
        organism: "mouse", outcome: "lifespan", year: 2013,
        cite: "Martin-Montalvo A et al., Nature Communications 4:2192",
        url: "https://pubmed.ncbi.nlm.nih.gov/23900241/",
        titleCheck: "Metformin improves healthspan and lifespan in mice"
      },
      {
        finding: "In the rigorous multi-site ITP, metformin ALONE did not significantly extend mouse lifespan (the rapamycin+metformin combination did).",
        organism: "mouse", outcome: "null", year: 2016,
        cite: "Strong R et al., Aging Cell 15:872-884 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/27312235/",
        titleCheck: "Longer lifespan in male mice treated with a weakly estrogenic agonist"
      }
    ],
    verdict: "Cheap, safe, famous — and it failed the gold-standard mouse test on its own. The human epidemiology that launched the hype has weakened under scrutiny. TAME would settle it; it hasn't run."
  },

  {
    id: "nad",
    name: "NAD+ precursors",
    aka: ["NR", "nicotinamide riboside", "NMN", "nicotinamide mononucleotide"],
    klass: "NAD+ metabolism boosters",
    what: "Supplements (NR, NMN) that reliably raise blood NAD+, a cofactor that declines with age in some tissues.",
    humanStatus: "Widely sold supplements. Multiple human RCTs show target engagement (NAD+ rises) and scattered functional signals; no aging outcome.",
    risks: ["Well tolerated in trials to date; long-term human data thin"],
    itp: true,
    evidence: [
      {
        finding: "First human chronic-dosing RCT of NR: well tolerated over 6 weeks and effectively raised blood NAD+ in healthy middle-aged and older adults.",
        organism: "human-rct", outcome: "biomarker", year: 2018,
        cite: "Martens CR et al., Nature Communications 9:1286",
        url: "https://pubmed.ncbi.nlm.nih.gov/29599478/",
        titleCheck: "Chronic nicotinamide riboside supplementation is well-tolerated and elevates NAD"
      },
      {
        finding: "10-week RCT of NMN in prediabetic postmenopausal women improved muscle insulin sensitivity — a narrow but real human functional effect.",
        organism: "human-rct", outcome: "biomarker", year: 2021,
        cite: "Yoshino M et al., Science 372:1224-1229",
        url: "https://pubmed.ncbi.nlm.nih.gov/33888596/",
        titleCheck: "Nicotinamide mononucleotide increases muscle insulin sensitivity in prediabetic women"
      },
      {
        finding: "In the multi-site ITP, nicotinamide riboside did not affect mouse lifespan in either sex at the dose tested.",
        organism: "mouse", outcome: "null", year: 2021,
        cite: "Harrison DE et al., Aging Cell 20:e13328 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/33788371/",
        titleCheck: "nicotinamide riboside and three other drugs do not affect lifespan in either sex"
      }
    ],
    verdict: "The supplements raise NAD+ — that part is proven in people. What raising NAD+ buys you is not: the rigorous mouse lifespan test came back empty."
  },

  {
    id: "dq",
    name: "Dasatinib + Quercetin",
    aka: ["D+Q", "senolytics"],
    klass: "Senolytic combination",
    what: "The flagship senolytic cocktail: a leukemia drug plus a flavonoid, dosed intermittently to kill senescent (\"zombie\") cells.",
    humanStatus: "Dasatinib is a prescription chemotherapy agent. Small open-label human pilots exist; placebo-controlled trials in age-related diseases are ongoing.",
    risks: [
      "Dasatinib is a real chemotherapeutic with real toxicity",
      "Killing senescent cells has plausible downsides (wound healing, tissue repair)"
    ],
    itp: false,
    evidence: [
      {
        finding: "Intermittent D+Q in already-old mice (24-27 months) improved physical function and extended remaining lifespan by ~36%.",
        organism: "mouse", outcome: "lifespan", year: 2018,
        cite: "Xu M et al., Nature Medicine 24:1246-1256",
        url: "https://pubmed.ncbi.nlm.nih.gov/29988130/",
        titleCheck: "Senolytics improve physical function and increase lifespan in old age"
      },
      {
        finding: "First-in-human senolytic pilot (idiopathic pulmonary fibrosis, n=14, open-label): physical function improved; no placebo arm, so a pilot signal only.",
        organism: "human-rct", outcome: "trial", year: 2019,
        cite: "Justice JN et al., EBioMedicine 40:554-563",
        url: "https://pubmed.ncbi.nlm.nih.gov/30872196/",
        titleCheck: "Senolytics in idiopathic pulmonary fibrosis"
      }
    ],
    verdict: "The most credible new mechanism in the field, with striking late-life mouse data — carried by a drug nobody should touch casually. Human proof is a pilot, not an answer."
  },

  {
    id: "fisetin",
    name: "Fisetin",
    aka: [],
    klass: "Flavonoid senolytic (candidate)",
    what: "A strawberry flavonoid promoted as a gentler over-the-counter senolytic.",
    humanStatus: "Supplement; randomized human trials in older adults are ongoing.",
    risks: ["Low toxicity at supplement doses; poor bioavailability"],
    itp: true,
    evidence: [
      {
        finding: "Reduced senescence markers and extended lifespan in progeroid and aged normal mice.",
        organism: "mouse", outcome: "lifespan", year: 2018,
        cite: "Yousefzadeh MJ et al., EBioMedicine 36:18-28",
        url: "https://pubmed.ncbi.nlm.nih.gov/30279143/",
        titleCheck: "Fisetin is a senotherapeutic that extends health and lifespan"
      },
      {
        finding: "In the multi-site ITP, fisetin did not significantly affect lifespan in either sex at the dose and schedule used — and did not reduce tissue senescence markers.",
        organism: "mouse", outcome: "null", year: 2023,
        cite: "Harrison DE et al., GeroScience 46:795-816 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/38041783/",
        titleCheck: "fisetin, SG1002 (hydrogen sulfide donor), dimethyl fumarate, mycophenolic acid, and 4-phenylbutyrate do not significantly affect lifespan"
      }
    ],
    verdict: "The friendly senolytic that flunked the rigorous retest. Human trials may still find disease-specific uses; the mouse longevity claim did not replicate."
  },

  {
    id: "resveratrol",
    name: "Resveratrol",
    aka: [],
    klass: "Polyphenol (sirtuin-activator hypothesis)",
    what: "The red-wine molecule that launched a thousand headlines and a billion-dollar acquisition.",
    humanStatus: "Supplement. Human trials showed metabolic tweaks at best; no longevity outcome.",
    risks: ["Well tolerated; GI upset at high doses"],
    itp: true,
    evidence: [
      {
        finding: "Improved health and survival of mice on a HIGH-CALORIE diet — the result that ignited the field.",
        organism: "mouse", outcome: "healthspan", year: 2006,
        cite: "Baur JA et al., Nature 444:337-342",
        url: "https://pubmed.ncbi.nlm.nih.gov/17086191/",
        titleCheck: "Resveratrol improves health and survival of mice on a high-calorie diet"
      },
      {
        finding: "In the multi-site ITP, resveratrol did NOT extend lifespan of healthy, normally-fed mice.",
        organism: "mouse", outcome: "null", year: 2011,
        cite: "Miller RA et al., J Gerontol A Biol Sci Med Sci 66:191-201 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/20974732/",
        titleCheck: "Rapamycin, but not resveratrol or simvastatin, extends life span of genetically heterogeneous mice"
      }
    ],
    verdict: "The field's cautionary tale in one molecule: a real effect in sick, overfed mice, sold as an immortality drug, gone when tested in healthy ones."
  },

  {
    id: "aspirin",
    name: "Aspirin",
    aka: ["acetylsalicylic acid"],
    klass: "NSAID / antiplatelet",
    what: "The century-old drug periodically nominated for longevity duty.",
    humanStatus: "Approved everywhere for other uses. ASPREE tested daily low-dose aspirin in 19,000 healthy elderly people.",
    risks: ["Major bleeding — demonstrated at scale in ASPREE's healthy-elderly population"],
    itp: true,
    evidence: [
      {
        finding: "Modestly increased lifespan of MALE mice in the ITP (pooled p=0.01); no female effect.",
        organism: "mouse", outcome: "lifespan", year: 2008,
        cite: "Strong R et al., Aging Cell 7:641-650 (ITP)",
        url: "https://pubmed.ncbi.nlm.nih.gov/18631321/",
        titleCheck: "Nordihydroguaiaretic acid and aspirin increase lifespan of genetically heterogeneous male mice"
      },
      {
        finding: "ASPREE randomized trial (~19,000 healthy adults ≥70): daily low-dose aspirin did NOT prolong disability-free survival and caused more major hemorrhage than placebo.",
        organism: "human-rct", outcome: "null", year: 2018,
        cite: "McNeil JJ et al., NEJM 379:1499-1508 (ASPREE)",
        url: "https://www.nejm.org/doi/full/10.1056/NEJMoa1800722",
        titleCheck: "Effect of Aspirin on Disability-free Survival in the Healthy Elderly"
      }
    ],
    verdict: "The rare candidate with a completed human aging-adjacent RCT — and the answer was no, with bleeding. Mouse wins are the start of the question, not the end."
  },

  {
    id: "urolithin",
    name: "Urolithin A",
    aka: [],
    klass: "Mitophagy activator (gut metabolite)",
    what: "A gut-bacterial metabolite of pomegranate ellagitannins that triggers mitochondrial recycling; sold as a supplement because many people's microbiomes don't make it.",
    humanStatus: "Supplement with several completed human RCTs on muscle endurance and mitochondrial markers; no longevity outcome.",
    risks: ["Well tolerated in trials to date"],
    itp: false,
    evidence: [
      {
        finding: "First-in-human RCT: safe, and induced a molecular signature of improved mitochondrial health in muscle of sedentary elderly adults.",
        organism: "human-rct", outcome: "biomarker", year: 2019,
        cite: "Andreux PA et al., Nature Metabolism 1:595-603",
        url: "https://www.nature.com/articles/s42255-019-0073-4",
        titleCheck: "urolithin A is safe and induces a molecular signature of improved mitochondrial and cellular health in humans"
      }
    ],
    verdict: "Honest, incremental human biomarker science — mitochondrial housekeeping, measurably nudged. Whether that moves the aging needle is unknown."
  }
];

/* The Interventions Testing Program — referenced throughout the atlas. */
export const ITP_NOTE =
  "ITP = the NIA Interventions Testing Program: the field's gold standard. Three independent " +
  "sites, genetically heterogeneous mice, pre-registered doses, hundreds of animals. Most " +
  "famous supplements fail it. A compound tagged ITP here was tested by that program.";
