# crap-detector

Détection déterministe de la dégradation d'une base de code TypeScript.
Métriques AST, hotspots git, duplication, code mort, cycles, couplage caché,
signatures d'« AI slop », et un cliquet qui fait échouer la CI dès qu'un chiffre empire.

La justification empirique de chaque métrique est dans [`docs/ETAT-DE-L-ART-2026.md`](docs/ETAT-DE-L-ART-2026.md).

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
| `crap-detector file <chemin>` | Un seul fichier, chemin rapide | 2 si violation |
| `crap-detector baseline` | Écrit `crap-detector-baseline.json` | 0 |
| `crap-detector check` | Compare à la baseline | 1 si régression |
| `crap-detector hotspots` | Classe par churn × complexité | 0 |
| `crap-detector explain <chemin>` | Ce qui est reproché à un fichier | 1 si findings |

Options : `--root`, `--json`, `--since <ref>`, `--no-git`, `--no-tools`, `--top`, `--limit`,
`--baseline`.

Codes de sortie : `0` propre, `1` gate en échec, `2` violation sur le fichier analysé,
`3` erreur d'usage.

## Les deux vitesses

C'est la contrainte qui structure tout le code.

- **`file`** ne fait que de l'AST : ni git, ni sous-processus, ni lecture de `node_modules`.
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
chez GitClear), `else` redondant, variable assignée puis retournée, ternaire booléen,
wrapper qui transmet ses paramètres à l'identique.

**Échappements de typage.** `any` explicite, `as unknown as`, `@ts-ignore`, `@ts-nocheck`.
`@ts-expect-error` n'est pas visé : il échoue une fois l'erreur disparue, donc il se nettoie.

**Hotspots.** `commits × complexité` sur la fenêtre d'historique. C'est la seule liste de
refactoring qui vaille : la complexité seule ne coûte rien si personne ne touche le fichier.

**Couplage caché.** Paires de fichiers qui changent toujours ensemble sans import entre eux.
Aucun linter ni analyse statique ne voit ça, seulement l'historique.

**Supply chain.** Import d'un paquet absent du `package.json` — la signature du
slopsquatting, quand un agent invente une dépendance plausible.

**Cycles et orphelins**, calculés sur le graphe d'imports interne (composantes fortement
connexes, Tarjan itératif).

**Code mort et duplication**, via `knip` et `jscpd`.

**Contre-mesures au gaming.** `functionsPerFile` et `medianFunctionSloc` : un agent qui
saucissonne pour passer sous un seuil fait monter le premier et chuter le second.

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
- Un changement de seuil, de périmètre ou de version d'outil rend la baseline
  incomparable : le gate échoue en demandant un nouveau snapshot, parce que ces chiffres
  ne sont réellement pas comparables.

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
  "scope": {
    "include": ["**/*.ts", "**/*.tsx"],
    "exclude": ["node_modules/**", "dist/**", "**/*.test.ts"]
  },
  "churn": {
    "windowDays": 365,
    "maxFilesPerCommit": 50,
    "minCoChangeCommits": 5,
    "minCoChangeDegree": 0.5
  }
}
```

Un fichier mal formé fait échouer la commande avec un message explicite. Jamais de repli
silencieux sur les défauts.

## Boucle d'agent

Le dépôt fournit un hook `PostToolUse` dans `.claude/`. Après chaque `Write` ou `Edit`
sur un fichier TypeScript, il lance le chemin rapide sur ce seul fichier ; en cas de
violation il sort en code 2, ce qui bloque l'action et renvoie les findings à l'agent,
qui corrige immédiatement.

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
