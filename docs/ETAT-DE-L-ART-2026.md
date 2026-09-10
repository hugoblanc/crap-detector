# Détecter la dégradation du code à l'ère des agents — État de l'art, août 2026

Fusion des deux rapports de veille d'août 2026 (données GitClear/arXiv/ThoughtWorks et étude approfondie des outils).
Document de référence du projet crap-detector.

## 1. Verdict

La préférence pour le déterministe est la bonne intuition, et elle est empiriquement fondée.
En août 2026, l'approche qui marche est une pile de checks programmatiques (linters à seuils stricts, analyse de dépendances, code mort, duplication, mutation testing) branchée en boucle courte sur les agents via hooks et MCP tools, avec un mécanisme de cliquet (baseline/ratchet) pour arrêter l'hémorragie sur du legacy sans tout refactorer.
Les consignes en prose (CLAUDE.md) sont des suggestions non exécutables : SlopCodeBench montre qu'un prompt anti-slop abaisse le point de départ mais ne ralentit pas la dégradation.
Les review bots LLM sont utiles en advisory mais immatures comme garde-fou : trois benchmarks publiés entre juillet 2025 et février 2026 ont couronné trois gagnants différents.

## 2. Les données empiriques

### 2.1 GitClear — « The Maintainability Gap » (2026)

Analyse de 623 millions de changements de code (2023-2026), huit signaux de qualité suivis.
Refactoring : le code déplacé/refactoré passe de 21 % des lignes changées en 2022, à 13 % en 2023, à 3,8 % début 2026, soit environ -70 %.
Duplication : blocs dupliqués (5+ lignes consécutives répétées) de 40,3 à 73,0 par million de lignes changées, soit +81 %, record historique.
Copy/paste intra-commit : de 9,4 % (2022) à 15,7 % (H1 2026) des lignes changées.
Connectivité : appels de fonctions inter-fichiers de 343 à 223 par millier de lignes changées (-35 %).
Maintenance legacy : part des changements touchant du code de plus de 12 mois de 1,7 % à 0,46 % (-74 %).
Error-masking (try/catch qui masquent les erreurs) : +47 % ; churn sur 2 semaines : +15 %.
En 2022 on refactorait 2 fois plus qu'on ne copiait ; en 2026 on copie-colle 5 fois plus qu'on ne refactor.
Thèse GitClear : ce n'est pas « l'IA écrit du mauvais code », ce sont les workflows agents qui récompensent l'ajout atomique et taxent la maintenance invisible — le dépôt passe en « write-only mode », il grossit pendant que l'existant calcifie.

### 2.2 DORA — State of AI-Assisted Software Development (2025)

Environ 90 % d'adoption de l'IA chez les développeurs interrogés.
Verbatim : « AI adoption not only fails to fix instability, it is currently associated with increasing instability ».
L'IA augmente le débit individuel mais dégrade la stabilité de livraison (change failures, rework, cycle times).
Nouvelle métrique « Rework Rate » (taux de retravail) comme signal précoce de dette.
Message central : « AI does not create elite organizations; it anoints them » — l'IA amplifie l'état existant du système.

### 2.3 Études académiques

« Debt Behind the AI Boom » (arXiv 2603.28592) : 304 362 commits IA vérifiés dans 6 275 repos GitHub, cinq assistants analysés.
Plus de 15 % des commits de chaque assistant introduisent au moins un défaut statique ; 89,1 % des défauts sont des code smells ; 24,2 % survivent encore au HEAD actuel.
« AI-Generated Smells » (arXiv 2605.02741) : loi inverse volume-qualité (corrélation 0,94 entre LOC totale et déclin architectural), signature machine récurrente (Long Method, couplage élevé, dépendances instables), concept de « Modular Mirage ».
« Beyond Bug Fixes » (arXiv 2601.20109) : 1 210 PR de bug-fix mergées par des agents, analysées avec SonarQube — les smells dominent aux sévérités critical/major, et les écarts entre agents disparaissent une fois normalisés par le churn ; le succès du merge ne prédit pas la qualité post-merge.
« Investigating The Smells of LLM Generated Code » (arXiv 2510.03029) : +63 % de smells en moyenne sur du Java généré par 4 LLM vs solutions de référence professionnelles.

### 2.4 SlopCodeBench (arXiv 2603.24755, mars 2026)

Étude U. Wisconsin-Madison/MIT sur les trajectoires itératives agentiques ; définit deux métriques déterministes.
Erosion = fraction de la masse de complexité concentrée dans les fonctions à CC > 10, avec mass(f) = CC(f) × √SLOC(f).
Verbosity = lignes dupliquées/inutiles via l'union de 137 règles ast-grep et des lignes de clones, normalisée par la LOC.
Résultats : l'érosion augmente sur 80 % des trajectoires, la verbosité sur 89,8 %.
Nombre moyen de fonctions à haute CC : de 4,1 à 37,0 par trajectoire ; CC max moyenne : de 27,1 à 68,2 ; cas extrême : un main() passant de CC 29 / 84 lignes à CC 285 / 1099 lignes en 8 itérations.
Comparaison aux dépôts open-source humains : le code agentique est 2,2× plus verbeux et plus érodé (verbosité 0,33 vs 0,15 ; érosion 0,68 vs 0,31), et l'écart se creuse à chaque itération alors que le code humain reste plat.
Intervention par prompt (« anti_slop », section 3.4) : réduit la verbosité et l'érosion de départ jusqu'à un tiers, sans changer le rythme de dégradation ; le taux de résolution strict baisse de 2,4 points en moyenne et le coût par checkpoint augmente de 12,1 %.
C'est l'argument empirique le plus fort pour des garde-fous programmatiques externes plutôt que des instructions en prose.

### 2.5 CodeScene et Code Red

White paper « AI-Ready Code » (Tornhill & Borg, jan 2026, v2 mars 2026 peer-reviewed) : le risque de défaut d'un changement IA augmente d'au moins 30-60 % dans du code « unhealthy » (mesuré sur Code Health ≥ 7).
Les agents brûlent jusqu'à ~50 % de tokens en plus dans le code problématique ; taux d'erreur ×2 à ×5.
Codebase enterprise moyenne : Code Health 5,15/10 ; passer au niveau elite (~9,1) vaut jusqu'à 15× moins de défauts ; cible « AI-ready » recommandée : 9,5.
« Code Red: The Business Impact of Code Quality » (TechDebt 2022, DOI 10.1145/3524843.3528091) : sur 39 codebases propriétaires, le code de basse qualité contient 15× plus de défauts, prend 124 % plus de temps à corriger, avec 9× plus d'incertitude de cycle time ; la dette gaspille jusqu'à 42 % du temps des devs.

## 3. Métriques déterministes

### 3.1 Complexité : cyclomatique vs cognitive

Complexité cyclomatique (McCabe, 1976) : nombre de chemins indépendants ; excellente pour estimer l'effort de test, mais corrèle si fortement avec la LOC qu'elle n'a presque aucun pouvoir explicatif propre sur les défauts.
Seuil canonique « haute complexité » : CC > 10 (cutoff McCabe/Radon, repris par SlopCodeBench).
Complexité cognitive (Sonar, 2017) : conçue pour l'understandability ; trois règles — ignorer les raccourcis syntaxiques, incrémenter sur les ruptures de flux linéaire, incrémenter davantage sur l'imbrication.
Seuil recommandé : ≤ 15 par fonction (défaut eslint-plugin-sonarjs).
Validée empiriquement (arXiv 2007.12520) comme meilleure que la CC pour prédire la compréhension.
Halstead, NPath, profondeur d'imbrication, longueur, nombre de paramètres : utiles comme garde-fous à seuil, pas comme score absolu.

### 3.2 Couplage et architecture

dependency-cruiser (JS/TS) : policy engine sur le graphe d'imports — cycles interdits, orphelins, prod→dev deps, boundaries par liste blanche ; `depcruise --init` génère des règles de départ.
madge : rapide pour lister les cycles (`madge --circular --extensions ts,tsx src/`), mode baseline possible.
ArchUnit (Java), ArchUnitTS / ts-arch (TypeScript) : l'architecture testée comme du code.
Pattern flag-file (lastminute.com) : chaque module déclare ses imports autorisés dans son propre fichier de règles, avec règles inverses auto-générées.
Trajectoire monorepo : extraire un module en workspace package seulement quand son graphe d'imports est déjà propre.
LCOM pour la cohésion ; Structure101/NDepend/Sonargraph pour couplage afferent/efferent et instabilité.

### 3.3 Duplication

jscpd : détecteur multi-langages de clones type 1/2/3 ; défauts min-lines 5 / min-tokens 50.
Gate CI recommandé pour un projet neuf : duplication ≤ 3-5 %.
C'est le signal numéro 1 de l'ère IA selon GitClear (+81 %) et leur contre-mesure recommandée : tripwire dès qu'un bloc dupliqué apparaît dans une MR.

### 3.4 Code mort

knip est l'outil de référence 2025-2026 : fichiers, exports, types, dépendances inutilisés, exports en double, cycles ; 150+ plugins framework ; exit code 1 pour la CI.
ts-prune est en maintenance et renvoie explicitement vers knip.
Les agents laissant beaucoup de code orphelin, knip est le contrepoids direct au write-only mode ; des retours d'expérience rapportent des dizaines d'exports morts supprimés en une passe.

### 3.5 Type safety

`"strict": true` plus `"noUncheckedIndexedAccess": true` (non inclus dans strict ; crucial contre l'accès indexé non vérifié généré par IA).
type-coverage avec cible ≥ 99 % (`atLeast: 99`, valeur recommandée par l'outil).
Bannir : `@typescript-eslint/no-explicit-any` (le noImplicitAny du compilateur ne couvre pas les any explicites), `@typescript-eslint/ban-ts-comment` (préfère @ts-expect-error avec description), `@typescript-eslint/no-unnecessary-type-assertion` (casts `as unknown as`).

### 3.6 Tests : mesurer la vraie qualité, pas la coverage

Coverage mesure l'exécution, pas l'assertion : 80 % de coverage sans assertions passe le gate.
Mutation testing (Stryker JS/TS, PIT Java, mutmut Python, cargo-mutants Rust) : mesure déterministe de référence de la qualité des tests ; chasser les survived mutants plutôt que viser un score agrégé.
Très pertinent contre l'AI slop : les tests générés par IA « scorent bas » car ils miment l'implémentation sans assertions réelles (le coverage trap).
Coûteux : diff-scoped sur les modules critiques (`--since`/`--in-diff`), advisory d'abord puis bloquant quand la baseline locale est propre, sweep complet hebdomadaire ratissant contre une baseline versionnée (pattern cargo-mutants `mutants-baseline.json`).

### 3.7 Churn et hotspots

Behavioral code analysis (Tornhill, « Your Code As A Crime Scene », « Software Design X-Rays ») : croiser fréquence de changement et complexité pour prioriser la dette là où elle coûte.
Hotspot = code compliqué modifié souvent ; pattern universel : une petite partie du code concentre l'essentiel de l'activité.
Exemple CodeScene : 1,2 % de la codebase concentre 12,5 % de l'effort et 45 % des bugs.
Change/temporal coupling (fichiers qui changent toujours ensemble sans dépendance explicite) révèle le couplage caché.
Outils open-source : code_maat, git-of-theseus ; version DIY : `git log --numstat` agrégé × rapport de complexité.

## 4. Quality gates et cliquet

### 4.1 Clean as You Code

SonarQube/SonarCloud applique le gate uniquement au new code (version, nombre de jours ou branche de référence) : on n'est responsable que du code qu'on ajoute ou touche, jamais du legacy.
Gate « Sonar way » : zéro nouvelle issue, hotspots sécurité 100 % revus, duplication ≤ 3 %, coverage ≥ 80 % sur le nouveau code.
SonarQube AI Code Assurance marque les projets contenant de l'IA et exige un gate qualifié.
Depuis SonarQube Server 2026.4, le gate « Sonar way for Agentic AI » ajoute des conditions supply-chain contre les packages hallucinés/typosquattés installés par les agents, et des règles agentic (injection CLI, risques MCP, fuites de données).

### 4.2 Le cliquet (ratchet)

ESLint bulk suppressions natives (avril 2025) : `eslint --fix --suppress-all` gèle la dette existante dans `eslint-suppressions.json` et rend la règle error pour tout nouveau code.
Si de nouvelles violations apparaissent dans un fichier déjà suppressé, ESLint les montre toutes (choix intentionnel, anti-contournement).
Bonne pratique : fichiers de suppression par package plutôt qu'un fichier racine (moins de conflits, ownership clair), protégeables par CODEOWNERS.
betterer généralise le cliquet à n'importe quelle métrique (complexité, type-coverage, duplication) : baseline figée, toute régression échoue.
madge/dependency-cruiser en mode baseline : cycles existants tolérés, nouveaux interdits ; réduire le compteur puis passer en strict (zéro cycle atteignable en 2-3 semaines à temps partiel).
Principes d'une baseline robuste : sans numéros de ligne (stable aux décalages et renames), auto-porteuse (versions des outils embarquées), refus explicite si seuils ou périmètre divergent plutôt que comparaison mensongère.

### 4.3 Hooks pre-commit et hooks d'agents

Pre-commit classiques : husky, lefthook, lint-staged.
Hooks d'agents Claude Code : PreToolUse (bloque avant exécution, exit 2), PostToolUse (formate/lint après édition, ex. prettier + eslint --fix sur le fichier touché), Stop (typecheck + tests en fin de session, attention à stop_hook_active contre les boucles infinies).
« Hooks guarantee behavior; prompts suggest it » : c'est la différence entre suggestion et garantie.
Trois types de handlers : command (shell déterministe), prompt (LLM mono-tour), agent (subagent).
Conseil de portabilité : écrire les hooks comme scripts shell autonomes dans `.claude/hooks/`.
CodeScene fournit un MCP server CodeHealth qui renvoie un feedback déterministe quand le risque de maintenabilité augmente (boucle auto-corrective).

### 4.4 Métriques de PR

Taille du diff, nombre de fichiers, danger.js pour règles custom (warn si diff > ~500-600 lignes, warn si code modifié sans tests correspondants).
Télémétrie Faros 2026 (22 000 devs) : taille de PR +51,3 % et temps de revue en forte hausse depuis l'IA.
Les gros diffs dégradent mécaniquement la qualité de revue, humaine comme automatique.

## 5. Approches LLM / agentiques

### 5.1 Review bots : benchmarks instables

Benchmark Greptile (juillet 2025, vendor, recall seul sans compter les faux positifs) : Greptile 82 %, Bugbot 58 %, Copilot 54 %, CodeRabbit 44 %, Graphite 6 %.
Benchmarks indépendants contradictoires : Augment place Bugbot 49 % et Greptile 45 % F-score, CodeRabbit 39 % avec 36 % de précision (~64 % de faux positifs) ; Martian 2026 place CodeRabbit premier à 51,2 % F1 ; Qodo (février 2026) annonce 60,1 % F1 ; Signal65 donne CodeRabbit vainqueur.
Consensus stable de la recherche : un outil basse précision finit ignoré intégralement, donc pire qu'inutile.
Conclusion : advisory only, jamais condition bloquante de merge.
Marché en consolidation : Cursor acquiert Graphite (déc. 2025), Sonar acquiert Gitar (mai 2026).

### 5.2 LLM-as-judge

Fiabilité limitée par variance, biais et non-déterminisme.
Pour le rendre plus reproductible : rubriques explicites, votes/ensembles, température basse, et surtout ancrage sur des métriques déterministes (donner au juge les scores de complexité/duplication).

### 5.3 L'hybride qui marche

Utiliser les métriques déterministes pour cibler (hotspots, haute complexité, duplication), le LLM pour qualifier/expliquer.
Mieux : faire produire par le LLM des règles déterministes (Semgrep, ast-grep, ESLint custom) à partir des anti-patterns récurrents → le jugement devient une règle versionnée et reproductible.
Semgrep : AST + dataflow, déterministe, 2500+ règles, `semgrep --test` contre les faux positifs.
ast-grep : recherche/réécriture structurelle YAML, idéal pour encoder les conventions d'équipe.

## 6. AI slop : signatures et détection

Signatures documentées : commentaires redondants, sur-abstraction, duplication avec variations, defensive coding inutile (try/catch qui avalent les erreurs — error-masking +47 % chez GitClear), helpers jetables, réimplémentation au lieu de réutilisation, hallucination de dépendances (slopsquatting).
Détecteurs dédiés émergents mais immatures : ai-slop-detector, AI Slop Index de Larridin.
Aujourd'hui les signaux les plus fiables restent la duplication sémantique (jscpd), le churn/revert (git mining) et l'érosion (SlopCodeBench) — tous calculables avec des outils éprouvés.

## 7. Codebase agent-friendly

Propriétés convergentes des frameworks de scoring (Factory.ai Agent Readiness, Codebase Readiness Assessment, CodeHealth comme proxy) : modules profonds à interface étroite, fonctions/fichiers petits, noms greppables honnêtes, frontières explicites, tests rapides et fins, pas de code mort ni de duplication, documentation structurée par dossier.
Point clé validé par plusieurs sources indépendantes : « A codebase with poor feedback loops will defeat any agent you throw at it. A codebase with fast feedback and clear instructions will make any agent dramatically more effective. »
Une petite fonction/un petit fichier tient dans un seul appel d'outil : l'agent raisonne dessus à pleine attention au lieu de paginer (cohérent avec Uncle Bob : fonctions 4-20 lignes, ≤ 3 arguments).

## 8. Recommandations

### 8.1 Legacy en désordre : arrêter l'hémorragie

Étape 0 — Cartographier sans rien modifier (1-3 jours) : behavioral analysis (hotspots churn × complexité, change coupling), puis états des lieux knip + madge/depcruise + jscpd + rapport complexité, archivés comme baseline.
Étape 1 — Poser le cliquet : ESLint bulk suppressions (règles à seuil en error, dette gelée), dependency-cruiser/madge mode baseline (cycles existants tolérés), betterer pour figer erosion/type-coverage/duplication.
Étape 2 — Boucle de feedback agents : hooks PostToolUse (format+lint sur fichier édité), Stop (typecheck+tests), et feedback métrique court après chaque édition.
Étape 3 — Rembourser par hotspot uniquement, pas de big-bang ; mutation testing diff-scoped avant refactor des zones critiques ; réduire les compteurs de suppressions puis passer en strict.
Déclencheurs : hotspot Code Health < 4 + churn élevé + agents bloqués ⇒ prioritaire sur toute nouvelle feature ; compteur de suppressions qui ne baisse pas sur 2 sprints ⇒ budget refactoring explicite (sinon +124 % de temps, cf. Code Red).

### 8.2 Greenfield : les règles au jour 1

Config ESLint flat de référence :
```
complexity: ['error', 10]
max-lines-per-function: ['error', { max: 50, skipComments: true }]
max-lines: ['error', 300]
max-depth: ['error', 3]
max-params: ['error', 4]
max-nested-callbacks: ['error', 3]
sonarjs/cognitive-complexity: ['error', 15]
import/no-cycle: 'error'
boundaries/element-types: [2, { default: 'disallow', rules: [...] }]
@typescript-eslint/no-explicit-any: 'error'
@typescript-eslint/ban-ts-comment: 'error'
@typescript-eslint/no-unnecessary-type-assertion: 'error'
```
TypeScript : strict + noUncheckedIndexedAccess, type-coverage ≥ 99 %.
knip en CI, jscpd ≤ 3-5 %, dependency-cruiser en error dès le début (pas encore de baseline à geler).
Tests : coverage différentielle + mutation score ≥ ~70 % sur le cœur métier (plus parlant que 95 % de coverage ligne).
Revue IA : un seul outil, en complément non bloquant.

### 8.3 Transversal

Ne jamais faire d'un review bot LLM un quality gate.
Transformer les jugements LLM récurrents en règles Semgrep/ast-grep versionnées.
Suivre 5-6 signaux dans le temps comme tableau de bord anti-slop : duplication jscpd, ratio moved/copy-paste, cycles, code mort knip, mutation score, Code Health des hotspots.

## 9. Caveats

Benchmarks de revue IA majoritairement vendeurs et instables : le « 82 % » de Greptile ignore la précision ; trois benchmarks récents, trois gagnants différents.
Conflits d'intérêts : CodeScene, GitClear, Factory.ai, Larridin vendent la solution au problème qu'ils décrivent ; leurs chiffres vont dans le même sens que la recherche indépendante et DORA, mais sont partiellement commerciaux (ex. « +60 % de défauts » vs « au moins +30 % » dans le communiqué).
Corrélation ≠ causalité : le code peut être de basse qualité parce qu'il a beaucoup de défauts, pas seulement l'inverse (reconnu dans Code Red).
Les métriques deviennent des cibles et se font contourner (découpage artificiel) : croiser plusieurs signaux, préférer le mutation testing difficile à truquer.
SlopCodeBench est très récent et référencé sur les modèles de son setup expérimental ; chiffres par-modèle à prendre comme propres à l'étude.
Mutation testing coûteux : jamais en gate PR full-codebase, seulement incrémental/nightly/ciblé.
Détecteurs d'AI slop dédiés immatures : leur préférer jscpd + knip + git mining tant qu'ils ne sont pas validés indépendamment.

## 10. Sources

GitClear — The Maintainability Gap : https://www.gitclear.com/the_ai_code_quality_maintainability_gap
GitClear — Write-Only Mode Research : https://www.gitclear.com/write_only_mode_ai_research
LeadDev — Code maintainability plummets in the AI coding era : https://leaddev.com/ai/code-maintainability-plummets-in-the-ai-coding-era
arXiv 2603.28592 — Debt Behind the AI Boom : https://arxiv.org/abs/2603.28592
arXiv 2605.02741 — AI-Generated Smells : https://doi.org/10.48550/arxiv.2605.02741
arXiv 2601.20109 — Beyond Bug Fixes : https://arxiv.org/html/2601.20109
arXiv 2510.03029 — Investigating the Smells of LLM Generated Code : https://arxiv.org/html/2510.03029
arXiv 2603.24755 — SlopCodeBench : https://arxiv.org/abs/2603.24755
arXiv 2007.12520 — validation de la complexité cognitive : https://arxiv.org/abs/2007.12520
Microsoft Research — A Causal Perspective on Smells in LLM-Generated Code : https://www.microsoft.com/en-us/research/publication/a-causal-perspective-on-measuring-explaining-and-mitigating-smells-in-llm-generated-code/
ThoughtWorks Technology Radar Vol. 34 (avril 2026) : https://www.thoughtworks.com/radar
DORA — State of AI-Assisted Software Development 2025 : https://dora.dev
CodeScene — Hotspots & Code Health : https://codescene.io/docs/guides/technical/hotspots.html
CodeScene — Prioritize technical debt : https://codescene.io/docs/guides/technical/prioritize-technical-debt.html
Code Red (Tornhill & Borg, TechDebt 2022) : DOI 10.1145/3524843.3528091
cargo-mutants — CI guide & PR-diff : https://mutants.rs/ci.html
StrykerJS : https://stryker-mutator.io
knip — Using knip in CI : https://knip.dev/guides/using-knip-in-ci
knip — Reporters : https://knip.dev/features/reporters
dependency-cruiser : https://github.com/sverweij/dependency-cruiser
lastminute.com Engineering — Architecture Boundaries at Scale : https://technology.lastminute.com/how-we-enforce-architecture-boundaries-at-scale-on-our-app/
Xebia — Frontend architecture with dependency-cruiser : https://xebia.com/blog/taking-frontend-architecture-serious-with-dependency-cruiser/
ArchUnit : https://www.archunit.org/
ast-grep : https://ast-grep.github.io
Semgrep : https://semgrep.dev
ESLint bulk suppressions : https://eslint.org/blog/2025/04/bulk-suppressions/
betterer : https://phenomnomnominal.github.io/betterer/
Augment — We benchmarked 7 AI code review tools : https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results
Greptile benchmarks : https://www.greptile.com/benchmarks
Signal65 — Evaluating AI code review tools : https://signal65.com/research/ai/evaluating-ai-code-review-tools-a-real-world-bug-detection-study
golden_comments (dataset d'évaluation tiers) : https://github.com/ai-code-review-evaluations/golden_comments
SonarSource — AI Code Assurance : https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-assurance/overview/
Sonar white paper — Cognitive Complexity : https://www.sonarsource.com/resources/cognitive-complexity/
jscpd : https://github.com/kucherenko/jscpd
