/* targets — THE SCIENTIFIC INPUTS. Everything the swarm computes is relative
 * to this file: a candidate's score is how much it looks like the molecules
 * listed here, so these molecules ARE the hypothesis. A wrong structure would
 * not throw an error — it would quietly produce a confident ranked list built
 * around a compound that does not exist, which is the worst failure this
 * project could have because it looks exactly like success.
 *
 * WHAT THIS FILE IS NOT. It is not a claim that any molecule below slows human
 * aging. Almost every result quoted here is from mice, worms, flies or cells;
 * where the human evidence is absent, each `why` says so in those words. No
 * compound in this file has been shown to lengthen human lifespan, and several
 * of them (resveratrol most famously) failed when the mouse experiment was
 * repeated under the strictest protocol available. Those failures are written
 * down here beside the hopes, because a reference set that only records
 * successes is advertising, not science.
 *
 * WHAT A HIGH SIMILARITY SCORE MEANS. Only this: "this candidate is built like
 * a molecule that did something measurable in a longevity experiment." That is
 * a reason for a researcher to look, and nothing more. Structural similarity is
 * not activity, activity in a worm is not activity in a person, and none of
 * this is medical advice or a suggestion that anyone consume anything.
 *
 * RULES THIS FILE OBEYS.
 *   1. Every reference molecule carries its PubChem CID, and CI fetches that
 *      CID and requires PubChem's structure and ours to agree — by molecular
 *      formula and by a 1000/1000 fingerprint match. A molecule is included
 *      only when both its CID and its full structure are known with
 *      confidence. Several obvious candidates (navitoclax, acarbose) are
 *      deliberately ABSENT rather than guessed at, because their structures
 *      are large and easy to get subtly wrong: a shorter list of certain
 *      molecules beats a longer one carrying two invented ones.
 *   2. SMILES are written in PubChem's Kekulé convention (uppercase atoms,
 *      explicit alternating double bonds) so that they compare cleanly against
 *      what PubChem returns. The screening path normalises aromaticity before
 *      fingerprinting (see aromatic.js), so ring spelling never reaches a
 *      score — but the CI comparison is happier when the spellings agree.
 *   3. Stereochemistry is written only where PubChem writes it. The Morgan
 *      fingerprint is stereo-blind by construction, so epimers and double-bond
 *      geometries screen identically; where that matters chemically (the
 *      17-alpha / 17-beta estradiol pair) the note says so out loud rather
 *      than letting a reader assume the screen can tell them apart.
 *   4. Determinism: this module holds data and one hash. No clock, no random
 *      source, no transcendental math, no locale-dependent formatting, no
 *      network. The digest is built from an explicitly ordered serialization,
 *      never from the iteration order of an object literal.
 *
 * Zero dependencies beyond the project's own SHA-256.
 */

import { sha256Hex } from "./digest.js";

/* The engine version is part of every unit digest. Two clients running
 * different builds must never be able to "confirm" each other's work, so this
 * string changes whenever the screening semantics change — including when a
 * reference molecule is added, removed or corrected. */
export const ENGINE_VERSION = "los-chem-2";
/* los-chem-2 (2026-09-06): metformin corrected to PubChem's tautomer spelling
 * (CN(C)C(=N)N=C(N)N, CID 4091). The old spelling shared its formula but
 * scored 322/1000 against the record — verify-molecules.mjs caught it the
 * first time it ran in CI. Nothing else in the reference set changed. */

/* ————————————————————————————————————————————————————————————————
 * THE TARGETS
 *
 * Each entry is one biological rationale plus the molecules that produced the
 * evidence for it. `why` states what was found and in which organism; when the
 * human evidence is missing it says that plainly, and when the strongest mouse
 * replication FAILED it says that too.
 * ———————————————————————————————————————————————————————————————— */

export const TARGETS = [
  {
    id: "mtor",
    name: "mTOR inhibition",
    pathway: "nutrient sensing — mTORC1 signalling and its brake on autophagy",
    why:
      "Rapamycin lengthened median and maximal lifespan in genetically heterogeneous mice in the " +
      "NIA Interventions Testing Program, in three laboratories at once, even when feeding began " +
      "at 20 months of age — the most replicated pharmacological lifespan result in mammals. " +
      "The mechanism (inhibition of mTORC1, which relieves a brake on autophagy) is conserved " +
      "from yeast to mice. In humans there is no lifespan evidence at all: the human trials are " +
      "short, small and measure immune or physical-function markers, not survival, and rapamycin " +
      "is an immunosuppressant with real risks.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/19587680/",
    actives: [
      {
        name: "Rapamycin",
        cid: 5284616,
        smiles:
          "CC1CCC2CC(C(=CC=CC=CC(CC(C(=O)C(C(C(=CC(C(=O)CC(OC(=O)C3CCCCN3C(=O)C(=O)C1(O2)O)C(C)CC4CCC(C(C4)OC)O)C)C)O)OC)C)C)C)OC",
        note: "Macrolide that binds FKBP12; the FKBP12-rapamycin complex inhibits mTORC1."
      },
      {
        name: "Everolimus",
        cid: 6442177,
        smiles:
          "CC1CCC2CC(C(=CC=CC=CC(CC(C(=O)C(C(C(=CC(C(=O)CC(OC(=O)C3CCCCN3C(=O)C(=O)C1(O2)O)C(C)CC4CCC(C(C4)OC)OCCO)C)C)O)OC)C)C)C)OC",
        note: "Rapamycin with a 2-hydroxyethyl ether at O-40; same target, shorter half-life."
      }
    ]
  },

  {
    id: "senolytic",
    name: "Senescent cell clearance",
    pathway: "apoptosis of senescent cells — BCL-2 family and tyrosine-kinase survival signalling",
    why:
      "Transplanting senescent cells into young mice caused lasting physical dysfunction, and " +
      "intermittent dasatinib plus quercetin removed senescent cells, reversed that dysfunction " +
      "and lengthened remaining lifespan in old mice by roughly a third. Fisetin produced a " +
      "similar survival effect in separate mouse work. Human data are limited to small open-label " +
      "and early randomised trials in fibrotic and metabolic disease that report senescence " +
      "markers, not survival; no human lifespan evidence exists. CITATION SCOPE: the paper below " +
      "reports the transplantation experiment and the dasatinib-plus-quercetin survival result; " +
      "the fisetin result and the human trials are separate publications.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/29988130/",
    actives: [
      {
        name: "Dasatinib",
        cid: 3062316,
        smiles: "CC1=C(C(=CC=C1)Cl)NC(=O)C2=CN=C(S2)NC3=NC(=NC(=C3)N4CCN(CC4)CCO)C",
        note: "Multi-target tyrosine-kinase inhibitor; in this context the D of the D+Q pair."
      },
      {
        name: "Quercetin",
        cid: 5280343,
        smiles: "C1=CC(=C(C=C1C2=C(C(=O)C3=C(C=C(C=C3O2)O)O)O)O)O",
        note: "Dietary flavonol; the Q of the D+Q pair, acting on BCL-2-family survival pathways."
      },
      {
        name: "Fisetin",
        cid: 5281614,
        smiles: "C1=CC(=C(C=C1C2=C(C(=O)C3=CC=C(C=C3O2)O)O)O)O",
        note: "Flavonol closely related to quercetin, lacking the 5-hydroxyl."
      }
    ]
  },

  {
    id: "metabolic_ampk",
    name: "AMPK and glucose handling",
    pathway: "energy sensing — AMPK activation, complex I inhibition and renal glucose disposal",
    why:
      "Metformin lengthened healthspan and lifespan in mice at one dose and shortened it at a " +
      "higher one, and the NIA programme found no lifespan effect from metformin alone in " +
      "genetically heterogeneous mice — the honest summary is a modest and dose-sensitive signal, " +
      "not a settled one. Canagliflozin, an SGLT2 inhibitor, lengthened median lifespan in male " +
      "but not female mice in that same programme. In humans these are ordinary diabetes drugs; " +
      "the TAME trial that would test the aging hypothesis in people has not reported, so there " +
      "is no human lifespan evidence. CITATION SCOPE: the paper below reports the metformin " +
      "dose-response in mice; the metformin null and the canagliflozin result from the NIA " +
      "programme are separate publications.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/23900241/",
    actives: [
      {
        name: "Metformin",
        cid: 4091,
        smiles: "CN(C)C(=N)N=C(N)N",
        note: "Biguanide; indirect AMPK activation and mild mitochondrial complex I inhibition."
      },
      {
        name: "Canagliflozin",
        cid: 24812758,
        smiles: "CC1=CC=C(C=C1CC2=CC=C(S2)C3=CC=C(C=C3)F)C4C(C(C(C(O4)CO)O)O)O",
        note: "SGLT2 inhibitor; C-glucoside that lowers glucose by renal excretion."
      },
      {
        name: "Dapagliflozin",
        cid: 9887712,
        smiles: "CCOC1=CC=C(C=C1)CC2=C(C=CC(=C2)C3C(C(C(C(O3)CO)O)O)O)Cl",
        note: "Second SGLT2 inhibitor of the same C-glucoside class; included as a scaffold anchor."
      }
    ]
  },

  {
    id: "nad_salvage",
    name: "NAD+ precursors",
    pathway: "NAD+ salvage — nicotinamide riboside kinase and NAMPT routes into the NAD+ pool",
    why:
      "Tissue NAD+ falls with age in mice, and feeding nicotinamide riboside raised NAD+, improved " +
      "mitochondrial and stem-cell function and modestly lengthened lifespan in aged mice. " +
      "Nicotinamide mononucleotide improved metabolic measures in mice but the lifespan evidence " +
      "for it is much thinner. Human trials of NR and NMN reliably raise blood NAD+ and have found " +
      "little consistent functional benefit so far; there is no human lifespan evidence.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/27127236/",
    actives: [
      {
        name: "Nicotinamide riboside",
        cid: 439924,
        smiles: "C1=CC(=C[N+](=C1)C2C(C(C(O2)CO)O)O)C(=O)N",
        note: "Pyridinium cation (the CID is the cation); phosphorylated by NRK1/2 into NMN."
      },
      {
        name: "Nicotinamide mononucleotide",
        cid: 14180,
        smiles: "C1=CC(=C[N+](=C1)C2C(C(C(O2)COP(=O)(O)[O-])O)O)C(=O)N",
        note: "Zwitterionic 5'-phosphate of nicotinamide riboside; direct NAD+ precursor."
      },
      {
        name: "Nicotinamide",
        cid: 936,
        smiles: "C1=CC(=CN=C1)C(=O)N",
        note: "The salvage-pathway base; also a sirtuin inhibitor at higher concentrations."
      },
      {
        name: "Nicotinic acid",
        cid: 938,
        smiles: "C1=CC(=CN=C1)C(=O)O",
        note: "Niacin; enters NAD+ by the Preiss-Handler route rather than the salvage route."
      }
    ]
  },

  {
    id: "polyamine_autophagy",
    name: "Polyamines and autophagy induction",
    pathway: "autophagy — hypusination of eIF5A and inhibition of histone acetyltransferases",
    why:
      "Spermidine lengthened lifespan in yeast, nematodes and flies, with the effect abolished " +
      "when core autophagy genes were removed — which is the strongest kind of mechanistic " +
      "evidence available in these organisms. Later work reported reduced age-related pathology " +
      "in mice. Polyamine levels decline with age across species. In humans the evidence is " +
      "observational dietary-intake association plus small trials of cognitive measures; no " +
      "human lifespan evidence exists. CITATION SCOPE: the paper below reports the yeast, fly " +
      "and nematode lifespan work and its autophagy dependence; the mouse findings are separate, " +
      "later publications.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/19801973/",
    actives: [
      {
        name: "Spermidine",
        cid: 1102,
        smiles: "NCCCNCCCCN",
        note: "Triamine; the polyamine most consistently tied to autophagy induction."
      },
      {
        name: "Spermine",
        cid: 1103,
        smiles: "NCCCNCCCCNCCCN",
        note: "Tetraamine formed from spermidine; interconverts with it in the polyamine cycle."
      },
      {
        name: "Putrescine",
        cid: 1045,
        smiles: "NCCCCN",
        note: "Diamine precursor of spermidine; anchors the short-chain end of the scaffold."
      }
    ]
  },

  {
    id: "mitophagy",
    name: "Mitophagy induction",
    pathway: "selective clearance of damaged mitochondria and mitochondrial turnover",
    why:
      "Urolithin A, a gut-microbial metabolite of ellagitannins from pomegranate and walnuts, " +
      "induced mitophagy, lengthened lifespan in C. elegans and improved muscle function in " +
      "rodents. Human randomised trials in older adults report improvements in muscle endurance " +
      "and mitochondrial gene expression; those are function endpoints in short trials, and there " +
      "is no human lifespan evidence. Spermidine appears here as well because its autophagy effect " +
      "includes mitochondrial turnover. CITATION SCOPE: the paper below reports the C. elegans " +
      "and rodent work; the human trials are separate, later publications.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/27400265/",
    actives: [
      {
        name: "Urolithin A",
        cid: 5488186,
        smiles: "O=C1OC2=CC(O)=CC=C2C3=CC=C(O)C=C13",
        note: "3,8-dihydroxy-6H-dibenzo[b,d]pyran-6-one; a gut-microbiome metabolite, not a plant compound."
      },
      {
        name: "Spermidine",
        cid: 1102,
        smiles: "NCCCNCCCCN",
        note: "Listed under polyamines too; its autophagy induction covers mitochondrial turnover."
      }
    ]
  },

  {
    id: "sirtuin_polyphenol",
    name: "Sirtuin-associated polyphenols",
    pathway: "stilbene and flavonoid polyphenols — reported SIRT1 and AMPK modulation",
    why:
      "Resveratrol improved survival and metabolic health in mice fed a high-calorie diet, but when " +
      "the NIA Interventions Testing Program repeated the experiment in genetically heterogeneous " +
      "mice on a normal diet it found NO lifespan effect, and the claim that resveratrol directly " +
      "activates SIRT1 was traced to an artefact of the fluorophore-tagged assay used to measure " +
      "it. This target is kept precisely because that history is instructive: the scaffold is a " +
      "reasonable structural anchor, and the evidence behind it is weaker than its reputation. " +
      "There is no human lifespan evidence. CITATION SCOPE: the paper below is the original " +
      "high-calorie-diet mouse result; the NIA null replication and the fluorophore-assay " +
      "artefact are separate publications.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/17086191/",
    actives: [
      {
        name: "Resveratrol",
        cid: 445154,
        smiles: "OC1=CC(O)=CC(=C1)/C=C/C1=CC=C(O)C=C1",
        note: "trans-3,5,4'-trihydroxystilbene; the reference stilbene scaffold."
      },
      {
        name: "Pterostilbene",
        cid: 5281727,
        smiles: "COC1=CC(OC)=CC(=C1)/C=C/C1=CC=C(O)C=C1",
        note: "3,5-dimethyl ether of resveratrol; more metabolically stable, same scaffold."
      },
      {
        name: "Quercetin",
        cid: 5280343,
        smiles: "C1=CC(=C(C=C1C2=C(C(=O)C3=C(C=C(C=C3O2)O)O)O)O)O",
        note: "Listed under senolytics too; included here as the flavonol polyphenol anchor."
      }
    ]
  },

  {
    id: "dietary_metabolites",
    name: "Simple dietary and endogenous metabolites",
    pathway: "amino-acid and TCA-cycle metabolites — one-carbon, sulfur and 2-oxoglutarate pools",
    why:
      "Glycine fed in the diet lengthened median lifespan in male and female genetically " +
      "heterogeneous mice in the NIA programme, a rare result for a nutrient. Alpha-ketoglutarate " +
      "started in late-life mice compressed the period of poor health and produced a modest median " +
      "lifespan gain, and taurine, whose blood levels fall with age, lengthened lifespan in mice " +
      "and improved health measures in monkeys in one large study. All three are ordinary " +
      "metabolites and none has human lifespan evidence; the taurine work in particular is a " +
      "single laboratory's result awaiting independent replication. CITATION SCOPE: the paper " +
      "below reports the glycine result; the alpha-ketoglutarate and taurine findings are " +
      "separate publications.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/30916479/",
    actives: [
      {
        name: "Glycine",
        cid: 750,
        smiles: "NCC(=O)O",
        note: "Simplest amino acid; one-carbon donor and a glutathione precursor."
      },
      {
        name: "Taurine",
        cid: 1123,
        smiles: "NCCS(=O)(=O)O",
        note: "Sulfonic-acid amino-acid analogue; not incorporated into protein."
      },
      {
        name: "Alpha-ketoglutaric acid",
        cid: 51,
        smiles: "OC(=O)CCC(=O)C(=O)O",
        note: "2-oxoglutarate; TCA intermediate and cosubstrate for dioxygenase enzymes."
      }
    ]
  },

  {
    id: "weak_estrogen",
    name: "Weakly estrogenic steroids",
    pathway: "estrogen-receptor signalling with reduced feminising activity",
    why:
      "17-alpha-estradiol lengthened median lifespan in male genetically heterogeneous mice in the " +
      "NIA programme and did not do so in females — one of the clearest sex-specific results in " +
      "the field. It is the epimer of the main human estrogen and binds the classical receptor far " +
      "more weakly, which is why it produces the metabolic effect with little feminisation in male " +
      "mice. There is no human lifespan evidence, and the mechanism behind the sex difference is " +
      "still unsettled.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/27312235/",
    actives: [
      {
        name: "17-alpha-estradiol",
        cid: 68570,
        smiles: "CC12CCC3C(C1CCC2O)CCC4=C3C=CC(=C4)O",
        note:
          "The C-17 epimer of estradiol. Written without stereodescriptors on purpose: the Morgan " +
          "fingerprint is stereo-blind, so this screen cannot tell the two epimers apart and must " +
          "not pretend otherwise — the mouse result is specific to the alpha epimer."
      },
      {
        name: "Estradiol",
        cid: 5757,
        smiles: "CC12CCC3C(C1CCC2O)CCC4=C3C=CC(=C4)O",
        note:
          "17-beta-estradiol, the ordinary human estrogen, included as the named comparator. It is " +
          "indistinguishable from the entry above under a stereo-blind fingerprint; both are here " +
          "so nobody reads a scaffold match as evidence about which epimer was tested."
      }
    ]
  },

  {
    id: "nsaid_inflammation",
    name: "NSAIDs and chronic inflammation",
    pathway: "cyclooxygenase inhibition and the age-associated inflammatory background",
    why:
      "Aspirin lengthened median lifespan in male but not female genetically heterogeneous mice in " +
      "the NIA programme, an effect small enough that it is best described as a hint about the " +
      "inflammatory background of aging rather than an established intervention. Ibuprofen " +
      "lengthened lifespan in yeast, worms and flies in separate work. Human evidence is " +
      "observational and confounded, and long-term NSAID use carries bleeding and renal risks; " +
      "there is no human lifespan evidence.",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/18631321/",
    actives: [
      {
        name: "Aspirin",
        cid: 2244,
        smiles: "CC(=O)OC1=CC=CC=C1C(=O)O",
        note: "Acetylsalicylic acid; irreversible COX acetylation."
      },
      {
        name: "Ibuprofen",
        cid: 3672,
        smiles: "CC(C)CC1=CC=C(C=C1)C(C)C(=O)O",
        note: "Arylpropionic-acid NSAID; reversible COX inhibition."
      }
    ]
  }
];

/* Frozen so that a hostile or careless caller in the same page cannot rewrite
 * the reference set between two work units and silently change what every
 * subsequent digest means. Freezing is shallow per object, so walk it. */
(function freeze(node) {
  if (node === null || typeof node !== "object") return;
  Object.freeze(node);
  for (const k of Object.keys(node)) freeze(node[k]);
})(TARGETS);

/* ————————————————————————————————————————————————————————————————
 * THE DIGEST
 *
 * Every work-unit digest carries this hash, so a client whose targets.js
 * differs by one character can never confirm another client's result. That
 * makes the serialization below part of the protocol, not an implementation
 * detail, and it is written out by hand for one reason: JSON.stringify of an
 * OBJECT commits to whatever key order the literal happened to have, which is
 * a property of this source file rather than of the data. Keys are therefore
 * listed explicitly, targets are sorted by id and actives by name, and the
 * only thing JSON.stringify is trusted with is escaping a single STRING —
 * which the language specifies exactly and identically in every engine, with
 * no locale involved.
 * ———————————————————————————————————————————————————————————————— */

/* Code-unit ordering. Deliberately not localeCompare: collation is locale data,
 * and locale data differs between machines. */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TARGET_KEYS = ["id", "name", "pathway", "why", "sourceUrl"];
const ACTIVE_KEYS = ["name", "cid", "smiles", "note"];

/* Every PRESENT value is stringified before quoting so that a cid written as a
 * number and the same cid written as a string can never produce two different
 * digests. That coercion is deliberate; collapsing ABSENCE into it was not.
 *
 * An absent field and an empty one are different facts — "this active has no
 * note" is not "this active's note is the empty string" — and this function
 * used to hash them to the same bytes, so two builds carrying genuinely
 * different reference data could produce one digest and "confirm" each other.
 *
 * Every field in the shipped TARGETS is a non-empty string or a positive
 * integer, so this change by itself moves NO digest (verified: byte-identical
 * canonical output before and after) and ENGINE_VERSION does not move with it.
 * It is closed now precisely because the digest is protocol: the collision
 * costs nothing to close today and becomes unfixable-in-place the moment an
 * optional field ships and real clients are hashing it. */
function field(key, value) {
  return JSON.stringify(key) + ":" +
    (value === undefined || value === null ? "null" : JSON.stringify(String(value)));
}

function canonical() {
  const targets = [...TARGETS].sort((a, b) => byString(String(a.id), String(b.id)));
  const parts = [];
  for (const t of targets) {
    const actives = [...(Array.isArray(t.actives) ? t.actives : [])]
      .sort((x, y) => byString(String(x.name), String(y.name)) || byString(String(x.cid), String(y.cid)));
    const activeParts = actives.map(
      (a) => "{" + ACTIVE_KEYS.map((k) => field(k, a[k])).join(",") + "}"
    );
    parts.push(
      "{" + TARGET_KEYS.map((k) => field(k, t[k])).join(",") +
      ',"actives":[' + activeParts.join(",") + "]}"
    );
  }
  return '{"engine":' + JSON.stringify(ENGINE_VERSION) + ',"targets":[' + parts.join(",") + "]}";
}

/* Computed once. The inputs are frozen and nothing here reads the outside
 * world, so the cached value is the same value the recomputation would give —
 * the cache is a speed choice, never a semantic one. */
let cached = null;

/**
 * SHA-256 over the canonical serialization of ENGINE_VERSION + TARGETS.
 *
 * @returns {string} 64 lowercase hex characters.
 */
export function targetsDigest() {
  if (cached === null) cached = sha256Hex(canonical());
  return cached;
}
