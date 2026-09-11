# crap-detector

> **Statut : expérimental (v0.1).**
> Le chemin rapide `crap-detector file`, celui du hook, tourne en environ 200 ms sur un fichier.
> Le scan complet tourne en 5 à 10 secondes et sous 600 Mo sur des dépôts de 700 à 800 fichiers.
> Les fichiers chargés par convention (migrations, tests e2e, scripts) sortent en `unused-file`
> tant que le dépôt n'a pas de `knip.json` qui les déclare : voir [Configurer knip](#configurer-knip)
> et les [issues ouvertes](https://github.com/hugoblanc/crap-detector/issues).
> À utiliser en local, à titre indicatif, pas encore comme gate de CI.

Détection déterministe de la dégradation d'une base de code TypeScript.
Métriques AST, hotspots git, duplication, code mort, cycles, couplage caché,
signatures d'« AI slop », et un cliquet qui fait échouer la CI dès qu'un chiffre empire.

La justification empirique de chaque métrique est dans [`docs/ETAT-DE-L-ART-2026.md`](docs/ETAT-DE-L-ART-2026.md).
Ce que valent ses alertes sur cinq dépôts réels, et les réglages par défaut qui en découlent, sont dans [`docs/PRECISION-2026-09.md`](docs/PRECISION-2026-09.md).

## Le principe

[SlopCodeBench](https://arxiv.org/abs/2603.24755) (section 3.4) a mesuré l'effet d'une consigne
de qualité adressée à un agent, du type « écris du code propre ».
Elle réduit la verbosité et l'érosion de départ, **sans changer le rythme de dégradation**
au fil des itérations.
Elle fait aussi baisser le taux de résolution de 2,4 points et augmente le coût par étape de 12,1 %.

La question utile n'est donc pas « comment demander à l'agent de ne pas produire de merde »
mais « quelle commande échoue quand il en produit ». Ce dépôt est cette commande.

## Installation

Le paquet n'est pas publié sur npm : il s'installe depuis GitHub, et se construit à l'installation.

```
pnpm add -D github:hugoblanc/crap-detector
```

Node 22 ou plus. `knip` et `jscpd` sont utilisés s'ils sont installés ; sinon leurs
métriques sont marquées « non mesuré » et le reste fonctionne.

## Commandes

| Commande | Ce qu'elle fait | Sortie |
| --- | --- | --- |
| `crap-detector scan` | Analyse complète du dépôt | 0 |
| `crap-detector file <chemin>` | Un seul fichier, chemin rapide | 2 si violation signalée |
| `crap-detector baseline` | Écrit `crap-detector-baseline.json` | 0 |
| `crap-detector check` | Compare à la baseline | 1 si régression |
| `crap-detector hotspots` | Classe par churn × complexité | 0 |
| `crap-detector explain <chemin>` | Ce qui est reproché à un fichier | 1 si findings |

Options : `--root`, `--json`, `--since <ref>`, `--no-git`, `--no-tools`, `--top`, `--limit`,
`--baseline`, `--all`.
`--all` affiche aussi les findings sous le seuil de signalement, voir [Deux niveaux de seuil](#deux-niveaux-de-seuil).

`--root` peut viser un sous-dossier du dépôt git, par exemple `app/` quand le `package.json`
n'est pas à la racine. L'historique est alors restreint aux commits qui touchent ce dossier,
avec des chemins relatifs à lui, comme ceux de l'analyse AST.

Codes de sortie : `0` propre, `1` gate en échec, `2` violation sur le fichier analysé,
`3` erreur d'usage.

## Les deux vitesses

C'est la contrainte qui structure tout le code.

- **`file`** ne fait que de l'AST : ni git, ni sous-processus, ni parcours de `node_modules`,
  où seul un paquet non déclaré est cherché par son chemin.
  Environ 200 ms de bout en bout, dont l'essentiel est le démarrage de Node.
  C'est ce qui le rend utilisable depuis un hook déclenché à chaque édition.
- **`scan`, `check`, `baseline`** ajoutent git, `knip` et `jscpd`, chargés par
  `import()` dynamique. Un import statique tirerait `knip` — plusieurs mégaoctets — dans
  chaque invocation, y compris celle du chemin rapide.

## Ce qui est mesuré

**Complexité par fonction.** Cyclomatique (McCabe) et cognitive (spec Sonar v1.7,
implémentée d'après le white paper et testée sur ses exemples publiés), longueur,
paramètres, profondeur d'imbrication, callbacks imbriqués.

**Érosion** (SlopCodeBench). Part de la masse de complexité concentrée dans les fonctions
au-delà du seuil cyclomatique, avec `mass(f) = CC(f) × √SLOC(f)`.
Repères de l'étude : 0,31 pour du code humain, 0,68 pour du code agentique.

**Verbosité** (SlopCodeBench). Lignes inutiles ou dupliquées sur le total.
Repères : 0,15 humain, 0,33 agentique. Elle augmente sur 89,8 % des trajectoires
agentiques, contre 80 % pour l'érosion : c'est le signal le plus fréquent des deux.

**Signatures d'AI slop.** `catch` vide ou qui ne fait que logger (error-masking, +47 %
chez GitClear).
`else` redondant, variable assignée puis retournée, ternaire booléen et wrapper qui transmet ses paramètres à l'identique sont désactivés par défaut, voir [Règles par défaut](#règles-par-défaut).

**Échappements de typage.** `any` explicite, `as unknown as`, `@ts-ignore`, `@ts-nocheck`.
`@ts-expect-error` n'est pas visé : il échoue une fois l'erreur disparue, donc il se nettoie.

**Hotspots.** `commits × complexité` sur la fenêtre d'historique. C'est la seule liste de
refactoring qui vaille : la complexité seule ne coûte rien si personne ne touche le fichier.

**Couplage caché.** Paires de fichiers qui changent toujours ensemble sans import entre eux.
Aucun linter ni analyse statique ne voit ça, seulement l'historique.

**Supply chain.** Chaque import de paquet est jugé contre le `package.json` le plus proche du fichier, pas seulement celui de la racine.
Un paquet non déclaré et introuvable dans tous les `node_modules` en remontant depuis le fichier sort en `unknown-dependency`, critique : c'est la signature du slopsquatting, quand un agent invente une dépendance plausible.
Un paquet non déclaré mais installé, arrivé par une dépendance transitive comme `express` via `@nestjs/platform-express`, sort en `unlisted-dependency`, majeur.
Un import utilisé seulement comme type ne sort pas si son `@types/` est déclaré : TypeScript l'efface, rien n'est chargé à l'exécution.
Quand knip a tourné, ses `unlisted-dependency` sur les fichiers que cette règle a pu juger sont écartés : un seul finding par cause.

**Cycles et orphelins**, calculés sur le graphe d'imports interne (composantes fortement
connexes, Tarjan itératif).
Les orphelins ne sont comptés que si knip n'a pas tourné (`--no-tools`, ou knip absent) : `unused-file` couvre le même besoin, et knip connaît les points d'entrée par convention, comme les pages Next.js, que le graphe ne voit pas.
Les tests restent hors mesure mais comptent alors comme importeurs : un module utilisé seulement par ses tests n'est pas orphelin.

**Code mort et duplication**, via `knip` et `jscpd`, sur le même périmètre que l'analyse AST.
`jscpd` ne reçoit que les fichiers du périmètre, et garde la config du dépôt (`.jscpd.json` ou clé `jscpd` du `package.json`), sauf `exitCode` et `threshold`.
`knip` lit tout le projet, pour que les tests, les points d'entrée et les conventions de framework comptent comme importeurs.
Seuls ses findings sur les fichiers du périmètre sont gardés, avec les dépendances du `package.json` qui les gouverne.
Le résumé dit combien de findings ont été écartés comme hors périmètre.

`unused-file`, `unused-export` et `unused-dependency` ne valent que ce que knip sait des points d'entrée : voir [Configurer knip](#configurer-knip).

**Monorepo.** knip lancé depuis la racine d'un dépôt dont les workspaces ne sont pas déclarés juge tout contre la racine : sur un monorepo pnpm sans `packages` dans `pnpm-workspace.yaml`, il a signalé comme inutilisés des centaines de fichiers d'un sous-projet Vite, contre quelques-uns lancé depuis le dossier du sous-projet.
Quand des sous-dossiers du périmètre ont leur propre `package.json`, le résumé les liste : scanner chacun séparément avec `--root <dossier>`.

**Contre-mesures au gaming.** `functionsPerFile` et `medianFunctionSloc` : un agent qui
saucissonne pour passer sous un seuil fait monter le premier et chuter le second.

## Configurer knip

Sans configuration, knip ne connaît que les points d'entrée du `package.json` et de ses plugins : tout fichier chargé autrement paraît mort, avec ses exports et ses dépendances.
Déclarer dans un `knip.json` (champs `entry` et `project`) les points d'entrée invisibles :

- scripts lancés par leur chemin, depuis un shell ou une CI ; un script importé seulement par un autre script sort aussi tant que le premier n'est pas déclaré ;
- serveur lancé par un script que knip ne suit pas, comme une commande de framework : ses modules sortent tous en `unused-file` ;
- migrations et seeds chargées par glob, comme celles de TypeORM ;
- fichiers désignés dans une config, par exemple un setup Vitest passé par `path.resolve` ;
- configs de test passées en argument, comme `jest --config test/jest-e2e.json`, que knip ne lit pas : ses specs e2e sortent sinon en `unused-file` ;
- fichiers chargés par la plateforme de déploiement, comme un `middleware.ts` Vercel dans une app Vite.

knip lit sa configuration à la racine analysée : `knip.json`, `knip.jsonc`, `.knip.json`, `.knip.jsonc`, `knip.ts`, `knip.js`, `knip.config.ts`, `knip.config.js`, ou la clé `knip` du `package.json`.
Tant qu'il n'y en a aucune, le résumé de `scan` le signale.

**Rapport jugé non fiable.** Quand plus d'un tiers des fichiers du périmètre, et au moins 10, sortent en `unused-file`, knip est jugé non fiable sur ce dépôt.
Le minimum garde un petit dépôt de basculer sur un seul fichier vraiment mort : ce fichier reste une régression qui le nomme, pas une baseline incomparable.
Ses findings `unused-file`, `unused-export`, `unused-type` et `unused-dependency` ne sont alors ni affichés ni comptés : ni agrégat `deadcode.*`, ni dette dans la baseline.
Le résumé texte et le champ `deadCode.reliability` du JSON disent combien de findings ont été écartés.
Les autres findings de knip, comme `unlisted-dependency`, et les autres outils ne changent pas.

Sur cinq dépôts réels sans configuration knip, la part de fichiers signalés inutilisés allait de 0,5 % à 14,5 % quand knip trouvait ses points d'entrée.
Sur un serveur dont il ratait l'entrée, elle montait à 50,5 % : 376 fichiers sur 744, dont les 8 vérifiés à la main étaient tous atteignables.
Un tiers laisse de la marge des deux côtés.

Un dépôt dont plus d'un tiers du code est vraiment mort voit aussi ce code masqué.
Le seuil se relève dans `crap-detector.json`, par exemple `"knip": { "maxUnusedFileFraction": 1 }` pour toujours juger knip fiable.

## Règles par défaut

Sur cinq dépôts TypeScript réels, 699 alertes vérifiées à la main étaient exactes à 89 %, mais utiles à 30 % seulement ([détail](docs/PRECISION-2026-09.md)).
Six règles exactes mais presque jamais utiles sont donc désactivées par défaut :

| Règle | Alertes utiles |
| --- | --- |
| `assign-then-return` | 0 % |
| `redundant-else` | 0 % |
| `boolean-ternary` | 0 % |
| `unused-type` (knip) | 2 % |
| `passthrough-wrapper` | 5 % |
| `nested-callbacks` | 12 % |

Désactivée, une règle n'est pas mesurée : ni finding, ni dette dans la baseline, ni lignes comptées dans la verbosité.
Chacune se réactive par sa clé dans la section `rules` de `crap-detector.json`, par exemple `"rules": { "redundant-else": true }`.
Une clé inconnue fait échouer la commande.

## Deux niveaux de seuil

Les six règles de taille et de complexité ont deux seuils.
Le seuil du cliquet, dans `thresholds`, décide de ce que la baseline compte.
Le seuil de signalement, dans `reportThresholds`, décide de ce que `scan`, `explain` et le hook `file` affichent par défaut.

| Règle | Clé | Cliquet | Signalement |
| --- | --- | --- | --- |
| `function-length` | `maxLinesPerFunction` | 50 | 100 |
| `file-length` | `maxFileLines` | 300 | 600 |
| `cyclomatic-complexity` | `cyclomaticComplexity` | 10 | 25 |
| `cognitive-complexity` | `cognitiveComplexity` | 15 | 30 |
| `nesting-depth` | `maxDepth` | 3 | 5 |
| `too-many-params` | `maxParams` | 4 | 6 |

Au-delà du seuil de signalement, un finding s'affiche.
Entre les deux seuils, il est compté par le cliquet mais masqué : le texte dit combien, `--all` les affiche, et le JSON les garde avec `"belowReportThreshold": true`.
Le hook `file` ne sort en code 2 que pour un finding affiché : une fonction de 55 lignes n'interrompt pas l'agent.
`check` affiche toujours les findings derrière une régression, masqués ou non, puisque ce sont eux qui font échouer le gate.
Changer un seuil de signalement ne rend pas la baseline incomparable : ce qui est compté ne change pas.
Sur les dépôts mesurés, la valeur médiane des alertes utiles était proche du double de celle des alertes exactes mais inutiles, d'où ces défauts.

## Le cliquet

`crap-detector baseline` fige l'état courant dans `crap-detector-baseline.json`, à commiter.
`crap-detector check` échoue dès qu'un chiffre empire. La dette existante devient de la
dette figée au lieu de dette croissante — la seule stratégie applicable à un dépôt déjà
en désordre, où un gate absolu échouerait le premier jour et serait désactivé le deuxième.

La baseline ne contient ni numéro de ligne ni identifiant : elle survit aux décalages et
aux renommages. Elle suit la dette par outil, règle et fichier.

Cinq règles la gardent honnête :

- **Un ratio ne fait échouer le gate que si sa grandeur absolue monte aussi.**
  `erosion.fraction`, `verbosity.fraction` et `duplication.percent` sont des ratios :
  supprimer du code sain les fait monter mécaniquement, puisque le dénominateur rétrécit,
  sans que rien n'ait empiré. Chacun est donc suivi avec son numérateur
  (`erosion.mass`, `verbosity.lines`, `duplication.lines`), et une hausse du ratio à
  numérateur constant est reportée comme tolérée au lieu de faire échouer. Sinon le gate
  punirait la suppression de code mort, que l'outil réclame par ailleurs via `knip`.
  Un ratio impossible, fraction au-delà de 1 ou pourcentage au-delà de 100, fait échouer la commande au lieu d'être écrit dans le rapport ou la baseline.

- **Deux unités de mesure, selon la nature de la règle.** Les règles qui mesurent une
  fonction (`cyclomatic-complexity`, `cognitive-complexity`, `function-length`,
  `file-length`, `nesting-depth`, `too-many-params`, `nested-callbacks`) sont suivies au
  **pire cas du fichier**. Toutes les autres sont suivies au **nombre d'occurrences**.
  Compter partout serait faux : découper une fonction de complexité cognitive 156 en trois
  fonctions à 77, 32 et 18 fait passer le compte de 1 à 3 alors que le fichier s'améliore,
  et le cliquet rejetterait exactement le refactoring qu'il réclame. Le maximum attrape
  aussi ce que le compte rate, comme un fichier qui grossit de 301 à 3000 lignes sans
  gagner de violation.
- Un agrégat absent d'un côté vaut « non mesuré », jamais zéro. Sinon un outil
  indisponible passerait pour une amélioration, et son retour pour une régression.
- Les clés de dette portent leur outil, donc `check --no-tools` ignore les entrées de
  `knip` au lieu de les compter comme corrigées.
  Les orphelins, mesurés seulement sans knip, ne sont comparés que si les deux scans les ont mesurés.
- Un changement de seuil, de périmètre ou de version d'outil rend la baseline
  incomparable : le gate échoue en demandant un nouveau snapshot, parce que ces chiffres
  ne sont réellement pas comparables. Le périmètre inclut le filtrage git : une baseline
  écrite sans lui (hors dépôt, ou avant qu'il existe) ne se compare pas à un scan qui l'applique.
  Il inclut aussi la restriction de `knip` et `jscpd` au périmètre : une baseline écrite quand ils comptaient hors périmètre ne se compare pas non plus.
  De même pour une baseline écrite avant les règles d'imports actuelles (`importRules`) : ses faux positifs de dépendances laisseraient de la marge à un vrai paquet inventé.
  De même quand les règles optionnelles activées diffèrent (`rules`), ou pour une baseline écrite avant leur sélection, qui les comptait toutes.
  De même enfin quand knip est jugé fiable d'un côté et non fiable de l'autre (`knipTrusted`) : sinon une avalanche de fichiers morts ferait passer tout le code mort pour corrigé, et le gate s'éteindrait sans échouer.
  Une baseline écrite avant ce jugement compte comme fiable ; une commande où knip n'a pas tourné ne compare pas ce jugement.

## Configuration

`crap-detector.json` à la racine du dépôt analysé, tout est optionnel :

```json
{
  "thresholds": {
    "cyclomaticComplexity": 10,
    "cognitiveComplexity": 15,
    "maxLinesPerFunction": 50,
    "maxFileLines": 300,
    "maxDepth": 3,
    "maxParams": 4,
    "maxNestedCallbacks": 3,
    "duplicationPercent": 3,
    "erosionFraction": 0.35,
    "verbosityFraction": 0.2
  },
  "reportThresholds": {
    "cyclomaticComplexity": 25,
    "cognitiveComplexity": 30,
    "maxLinesPerFunction": 100,
    "maxFileLines": 600,
    "maxDepth": 5,
    "maxParams": 6
  },
  "rules": {
    "assign-then-return": false,
    "boolean-ternary": false,
    "nested-callbacks": false,
    "passthrough-wrapper": false,
    "redundant-else": false,
    "unused-type": false
  },
  "scope": {
    "include": ["**/*.ts", "**/*.tsx"],
    "exclude": ["node_modules/**", "dist/**", "**/*.test.ts"]
  },
  "churn": {
    "windowDays": 365,
    "maxFilesPerCommit": 50,
    "minCoChangeCommits": 5,
    "minCoChangeDegree": 0.5
  },
  "knip": {
    "maxUnusedFileFraction": 0.33,
    "minUnusedFiles": 10
  }
}
```

Un fichier mal formé fait échouer la commande avec un message explicite. Jamais de repli
silencieux sur les défauts.

En plus des globs `exclude`, les fichiers que git ignore sortent du périmètre : sortie de
build (`.next/`), code généré, fichiers temporaires d'outils. C'est git qui tranche, donc
les `.gitignore` imbriqués, ceux des dossiers parents, `.git/info/exclude` et
`core.excludesFile` s'appliquent. Un fichier suivi reste analysé même s'il correspond à un
motif ignoré. Hors dépôt git, seuls les globs s'appliquent et le résumé le signale.
Ce filtrage vaut aussi avec `--no-git`, pour que le périmètre ne dépende pas du drapeau.

## Boucle d'agent

Le dépôt fournit un hook `PostToolUse` dans `.claude/`. Après chaque `Write` ou `Edit`
sur un fichier TypeScript, il lance le chemin rapide sur ce seul fichier ; en cas de
violation au-delà du seuil de signalement il sort en code 2. En `PostToolUse` le fichier est déjà écrit, donc rien n'est
annulé : Claude Code renvoie les findings à l'agent, qui corrige dans la foulée.

Deux skills accompagnent le CLI : `crap-check` (procédure de fin de tâche) et
`crap-hotspot` (par où commencer un refactoring).

## Recouvrement avec ESLint

Cinq règles sont volontairement redondantes avec ESLint : `complexity`, `max-lines`,
`max-depth`, `max-params`, `max-nested-callbacks`. crap-detector les garde parce qu'il
apporte trois choses qu'ESLint n'a pas : le cliquet sur agrégats, la dimension temporelle
(churn, couplage), et un format de sortie destiné à un agent.
Si les deux sont utilisés, garder un seul jeu de seuils comme source de vérité.

## Limites connues

- Le graphe d'imports résout le relatif et les alias `paths` du tsconfig. Il ne résout
  pas les alias de bundler (Vite, webpack) ni les workspaces de monorepo : sur ces
  dépôts, des arêtes manquent, donc des cycles et des couplages explicites peuvent
  être ratés.
- Un module virtuel fourni par un bundler ou un framework, comme `@theme/Layout` chez Docusaurus,
  n'est ni déclaré ni installé : il sort en `unknown-dependency` critique.
- Il n'y a pas de règles de frontières entre couches (`boundaries`). C'est le jour où
  il en faudra que `dependency-cruiser` redeviendra le bon outil.
- La détection de commentaires redondants est absente : aucune formulation déterministe
  n'en donne un taux de faux positifs acceptable.
- Chaque fonction est une racine de mesure, y compris les lambdas imbriquées, alors que
  la spec Sonar compte déjà leur contenu dans la fonction englobante. Une fonction et
  sa lambda interne peuvent donc produire deux findings pour le même code.

## Développement

```
pnpm install
pnpm check      # typecheck + lint + tests
pnpm build
```
