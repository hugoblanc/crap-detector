# crap-detector

> **Statut : expérimental (v0.1).**
> Le chemin rapide `crap-detector file`, celui du hook, tourne en environ 200 ms sur un fichier.
> Le scan complet tourne en 5 à 10 secondes et sous 600 Mo sur des dépôts de 700 à 800 fichiers.
> Les points d'entrée que le dépôt n'affirme ni par un script npm, ni par un dossier `scripts/`,
> ni par une configuration de test, comme un script lancé en sous-processus, sortent encore en
> `unused-file` : voir [Configurer knip](#configurer-knip)
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
  Une exception, assumée : un specifier ni déclaré ni résolu déclenche le balayage des
  déclarations ambiantes des paquets installés, de 6 à 65 ms selon le dépôt, payé une fois
  par manifeste. Sur le seul fichier des cinq dépôts mesurés qui le déclenche, l'appel passe
  de 200 à 246 ms, médianes de 8 exécutions entrelacées. C'est le cas nominal juste après
  qu'un agent a inventé un paquet, et c'est le prix à payer pour ne pas crier au loup.
- **`scan`, `check`, `baseline`** ajoutent git, `knip` et `jscpd`, chargés par
  `import()` dynamique. Un import statique tirerait `knip` — plusieurs mégaoctets — dans
  chaque invocation, y compris celle du chemin rapide.

## Ce qui est mesuré

**Complexité par fonction.** Cyclomatique (McCabe) et cognitive (spec Sonar v1.7,
implémentée d'après le white paper et testée sur ses exemples publiés), longueur,
paramètres, profondeur d'imbrication, callbacks imbriqués.
La cyclomatique ne compte un `&&`, un `||` ou un `??` que s'il pilote le flux : condition
de `if`, de boucle, de ternaire, ou expression prise comme instruction. `a ?? défaut` et
`x || 0` produisent une valeur, pas une branche à suivre.
`x ||= f()`, `x &&= f()` et `x ??= f()` pris comme instruction comptent : l'appel n'a lieu que parfois.

**Érosion** (SlopCodeBench). Part de la masse de complexité concentrée dans les fonctions
au-delà du seuil cyclomatique, avec `mass(f) = CC(f) × √SLOC(f)`.
Repères de l'étude : 0,31 pour du code humain, 0,68 pour du code agentique.

**Verbosité** (SlopCodeBench). Lignes inutiles ou dupliquées sur le total.
Repères : 0,15 humain, 0,33 agentique. Elle augmente sur 89,8 % des trajectoires
agentiques, contre 80 % pour l'érosion : c'est le signal le plus fréquent des deux.

**Signatures d'AI slop.** `catch` vide ou qui ne fait que logger (error-masking, +47 %
chez GitClear), quand le `try` attend une opération asynchrone : c'est là qu'un échec
réseau ou base disparaît sans trace. Un repli synchrone, `JSON.parse`, écriture
`localStorage`, sélecteur invalide, n'est pas signalé, il est presque toujours voulu.
La contrepartie est connue : un `readFileSync`, un `execSync` ou un pilote de base synchrone avalés ne sont plus signalés non plus, et sur un outillage en ligne de commande cette famille existe.
`else` redondant, variable assignée puis retournée, ternaire booléen et wrapper qui transmet ses paramètres à l'identique sont désactivés par défaut, voir [Règles par défaut](#règles-par-défaut).

**Échappements de typage.** `any` explicite, `as unknown as`, `@ts-ignore`, `@ts-nocheck`.
`@ts-expect-error` n'est pas visé : il échoue une fois l'erreur disparue, donc il se nettoie.

**Hotspots.** `commits × complexité` sur la fenêtre d'historique. C'est la seule liste de
refactoring qui vaille : la complexité seule ne coûte rien si personne ne touche le fichier.

**Couplage caché.** Paires de fichiers qui changent toujours ensemble sans import entre eux.
Aucun linter ni analyse statique ne voit ça, seulement l'historique.
Une paire n'est pas cachée si deux imports au plus la relient (barrel, intermédiaire), ou si les deux fichiers importent un même module de types : au moins un type déclaré, et aucune valeur laissée à l'exécution.
Un fichier qui exporte un schéma zod ou une table de constantes n'est donc pas un module de types : ses importeurs partagent du code, pas un contrat.
Les fichiers supprimés depuis sont ignorés, les renommés suivis, et les commits de plus de 20 fichiers écartés.
Sous 50 commits dans la fenêtre, le couplage n'est pas mesuré : les fichiers centraux d'un projet jeune changent ensemble par construction.

**Supply chain.** Chaque import de paquet est jugé contre le `package.json` le plus proche du fichier, pas seulement celui de la racine.
Un paquet non déclaré et introuvable dans tous les `node_modules` en remontant depuis le fichier sort en `unknown-dependency`, critique : c'est la signature du slopsquatting, quand un agent invente une dépendance plausible.
Avant de l'affirmer, le specifier est réellement résolu : résolution de modules TypeScript sous les options effectives du tsconfig le plus proche, `paths` et champ `exports` compris, puis recherche d'un `declare module '…'` dans les déclarations des paquets installés, dépendances transitives suivies.
Ces déclarations sont lues sur l'AST, pas sur le texte, et un motif qui couvrirait n'importe quel specifier, `declare module '*'`, est écarté : sans quoi un seul paquet transitif suffirait à éteindre la règle.
Un alias de framework comme `@theme/Layout` ou un sous-module déclaré en ambiant comme `@docusaurus/Link` ne sort donc plus : sur une règle critique, un faux positif coûte plus cher que le signal.
Un paquet non déclaré mais installé, arrivé par une dépendance transitive comme `express` via `@nestjs/platform-express`, sort en `unlisted-dependency`, majeur.
Un import utilisé seulement comme type ne sort pas si son `@types/` est déclaré : TypeScript l'efface, rien n'est chargé à l'exécution.
Quand knip a tourné, ses `unlisted-dependency` sur les fichiers que cette règle a pu juger sont écartés : un seul finding par cause.

**Cycles et orphelins**, calculés sur le graphe d'imports interne (composantes fortement
connexes, Tarjan itératif).
Un cycle ne compte que s'il existe à l'exécution : les imports effacés à l'émission (`import type`, symboles utilisés seulement comme types) et les `import()` dynamiques n'en créent pas.
Ce qui s'efface dépend des options effectives du tsconfig le plus proche, chaîne `extends` suivie : avec `verbatimModuleSyntax` seul `import type` disparaît, et avec `emitDecoratorMetadata` le type d'un paramètre de constructeur décoré reste importé (`design:paramtypes`), donc deux services NestJS qui s'injectent mutuellement forment bien un cycle.
Réserve connue sur ce dernier cas : chaque fichier est émis isolément, sans résolution des symboles entre fichiers, donc un paramètre décoré typé par une interface est traité comme une classe et compte comme cycle, alors que le compilateur émettrait `design:paramtypes` à `Object` et effacerait l'import.
Le motif ports et adaptateurs, où l'on injecte une interface plutôt qu'une classe, sort donc en faux positif.
Les orphelins ne sont comptés que si knip n'a pas tourné (`--no-tools`, ou knip absent) : `unused-file` couvre le même besoin, et knip connaît les points d'entrée par convention, comme les pages Next.js, que le graphe ne voit pas.
Les tests restent hors mesure mais comptent alors comme importeurs : un module utilisé seulement par ses tests n'est pas orphelin.

**Code mort et duplication**, via `knip` et `jscpd`, sur le même périmètre que l'analyse AST.
`jscpd` ne reçoit que les fichiers du périmètre, plus ceux des sous-projets vendorisés, et garde la config du dépôt (`.jscpd.json` ou clé `jscpd` du `package.json`), sauf `exitCode` et `threshold`.
`knip` lit tout le projet, pour que les tests, les points d'entrée et les conventions de framework comptent comme importeurs.
Seuls ses findings sur les fichiers du périmètre sont gardés, avec les dépendances du `package.json` qui les gouverne.
Le résumé dit combien de findings ont été écartés comme hors périmètre.

`unused-file`, `unused-export` et `unused-dependency` ne valent que ce que knip sait des points d'entrée : voir [Configurer knip](#configurer-knip).

Un fichier que knip classe `unused-file` est à supprimer, pas à refactorer : ses alertes de métriques et de slop passent sous le seuil de signalement, masquées du texte sans `--all`, toujours comptées par le cliquet.
Elles ne sont pas supprimées : le cliquet cesserait de surveiller ce fichier, et une fonction qui y passe de 57 à 302 lignes ne serait plus une régression.
Seulement si le dépôt a écrit sa propre configuration knip, qui dit ce qui est vraiment un point d'entrée.
Sans elle, knip devine, et sur un dépôt mesuré 12 des 15 fichiers ainsi classés morts restaient bien en place : la règle ne masque alors rien.
Le paquet non déclaré et les blocs dupliqués de ce fichier restent visibles : ils demandent un autre correctif, au `package.json` ou au fichier vivant qui porte la copie.

**Monorepo.** knip lancé depuis la racine d'un dépôt dont les workspaces ne sont pas déclarés juge tout contre la racine : sur un monorepo pnpm sans `packages` dans `pnpm-workspace.yaml`, il a signalé comme inutilisés des centaines de fichiers d'un sous-projet Vite, contre quelques-uns lancé depuis le dossier du sous-projet.
Quand des sous-dossiers du périmètre ont leur propre `package.json`, le résumé les liste : scanner chacun séparément avec `--root <dossier>`.

**Sous-projet vendorisé.** Un de ces sous-dossiers qu'aucun fichier du dépôt n'importe, tests compris, et que la racine ne déclare pas comme espace de travail (`workspaces` du `package.json`, `packages` du `pnpm-workspace.yaml`), sort du périmètre : le résumé le nomme, avec le nombre de fichiers et de lignes qu'il soustrait à la mesure.
Le mesurer gonflerait les agrégats et la baseline sans qu'aucune décision ne s'ensuive, puisque la seule action possible est de le scanner à part ou de le supprimer en bloc.
Les trois conditions se croisent toujours : un `package.json` réduit à `{"type": "module"}` règle le format des modules d'un dossier sans en faire un projet, un dossier importé de l'extérieur est du code du projet quel que soit son manifeste, et un dossier utilisé seulement par des tests n'est pas sans usage — même promesse que la règle orphan.
Le lecteur d'espaces de travail est maison, limité au champ `packages` (séquence en bloc, séquence de flux sur une ligne ou plusieurs, commentaires de fin de ligne compris) : tout ce qu'il ne sait pas lire désactive la détection, aucun dossier n'est écarté, et le résumé dit pourquoi.
`jscpd` continue de lire ses fichiers, sans jamais y poser de finding : un clone est une relation entre deux fichiers, et le retirer effacerait la copie que le code vivant en fait, qui est justement la raison de le supprimer.
Le champ `scope.vendored` de la baseline enregistre la liste : elle change, la baseline est déclarée incomparable plutôt que de faire passer la dette du sous-projet pour corrigée.

**Contre-mesures au gaming.** `functionsPerFile` et `medianFunctionSloc` : un agent qui
saucissonne pour passer sous un seuil fait monter le premier et chuter le second.

## Configurer knip

Sans configuration, knip ne connaît que les points d'entrée du `package.json` et de ses plugins : tout fichier chargé autrement paraît mort, avec ses exports et ses dépendances.
C'est la première cause de faux positifs mesurée sur cinq dépôts réels : 19 des 24 faux d'un échantillon de 497 alertes vérifiées à la main.

**Ce que crap-detector déclare tout seul.** Quand le dépôt n'a pas sa propre configuration knip, le scan en écrit une temporaire, hors du dépôt, qui reconduit les entrées par défaut de knip et y ajoute ce que le dépôt affirme lui-même :

- les fichiers source nommés par un script du `package.json`, par exemple la cible d'un `dev` ou d'un `tsx scripts/…` ;
- la commande d'un `nodemon.json` ou d'un `nodemonConfig`, quand un script lance `nodemon` ;
- les dossiers `scripts/` et `bin/`, à la racine comme sous n'importe quel dossier du périmètre, lintés et formatés comme le reste du dépôt et pourtant jamais importés ;
- les tests d'une seconde configuration jest citée par un script, comme `jest --config test/jest-e2e.json`, dont knip ne lit que la première : ses `testMatch`, ses `testRegex` et ses fichiers de setup deviennent des entrées.

Le résumé de `scan` dit combien de points d'entrée ont été déclarés.
Un paquet qui n'expose qu'un binaire, `bin` sans `main`, `module`, `exports` ni `types`, n'est jamais signalé inutilisé : aucun analyseur d'imports ne peut voir une CLI lancée à la main ou par un workflow.

**Ce qu'il faut encore déclarer soi-même**, dans un `knip.json` (champs `entry` et `project`) :

- un script lancé en sous-processus, `spawn(['tsx', 'scripts/…'])`, dont le chemin n'est qu'une chaîne de caractères ;
- un fichier désigné par un alias de configuration, par exemple un `resolve.alias` d'un `vitest.config.ts` ;
- un fichier chargé par la plateforme de déploiement, comme un `middleware.ts` Vercel dans une app Vite ;
- des migrations ou des seeds chargées par glob, comme celles de TypeORM ;
- les entrées d'un sous-projet d'un monorepo dont les workspaces ne sont pas déclarés : ce qui est déclaré automatiquement l'est pour le workspace racine.

knip lit sa configuration à la racine analysée : `knip.json`, `knip.jsonc`, `.knip.json`, `.knip.jsonc`, `knip.ts`, `knip.js`, `knip.config.ts`, `knip.config.js`, ou la clé `knip` du `package.json`.
Dès qu'il y en a une, elle fait foi : crap-detector ne déclare plus rien.

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
Sept règles exactes mais presque jamais utiles sont donc désactivées par défaut :

| Règle | Alertes utiles |
| --- | --- |
| `assign-then-return` | 0 % |
| `redundant-else` | 0 % |
| `boolean-ternary` | 0 % |
| `unused-type` (knip) | 2 % |
| `passthrough-wrapper` | 5 % |
| `nested-callbacks` | 12 % |
| `superfluous-export` (knip) | 0 % |

`superfluous-export` est la part de `unused-export` qui ne demande que de retirer un mot-clé : le symbole n'a pas d'importeur, mais il sert dans son propre fichier.
knip range les deux sous le même verdict ; l'usage local se lit sur l'AST du fichier.
Sur les 32 alertes `unused-export` vérifiées à la main, 19 sortent ainsi de la règle, aucune n'ayant été jugée utile à corriger, et les 13 qui restent en comptent 5 : l'utilité passe de 16 % à 38 %.
Ce qui reste sous `unused-export` est majeur, avec deux messages : « ré-export jamais importé, la ligne peut être retirée » quand le symbole vient d'un `export … from '…'`, où il vit toujours dans son module d'origine, et « symbole mort, supprimable » sinon.
L'export superflu sort en mineur, règle activable par `"rules": { "superfluous-export": true }`.

Désactivée, une règle n'est pas mesurée : ni finding, ni dette dans la baseline, ni lignes comptées dans la verbosité.
Chacune se réactive par sa clé dans la section `rules` de `crap-detector.json`, par exemple `"rules": { "redundant-else": true }`.
Une clé inconnue fait échouer la commande.

## Deux niveaux de seuil

Les six règles de taille et de complexité ont deux seuils.
Le seuil du cliquet, dans `thresholds`, décide de ce que la baseline compte.
Le seuil de signalement, dans `reportThresholds`, décide de ce que `scan`, `explain` et le hook `file` affichent par défaut.

| Règle | Clé | Cliquet | Signalement |
| --- | --- | --- | --- |
| `function-length` | `maxLinesPerFunction` | 55 | 100 |
| `file-length` | `maxFileLines` | 330 | 600 |
| `cyclomatic-complexity` | `cyclomaticComplexity` | 10 | 25 |
| `cognitive-complexity` | `cognitiveComplexity` | 17 | 30 |
| `nesting-depth` | `maxDepth` | 3 | 5 |
| `too-many-params` | `maxParams` | 4 | 6 |

Au-delà du seuil de signalement, un finding s'affiche.
Entre les deux seuils, il est compté par le cliquet mais masqué : le texte dit combien, `--all` les affiche, et le JSON les garde avec `"belowReportThreshold": true`.
Le hook `file` ne sort en code 2 que pour un finding affiché : une fonction de 55 lignes n'interrompt pas l'agent.
`check` affiche toujours les findings derrière une régression, masqués ou non, puisque ce sont eux qui font échouer le gate.
Changer un seuil de signalement ne rend pas la baseline incomparable : ce qui est compté ne change pas.
Sur les dépôts mesurés, la valeur médiane des alertes utiles était proche du double de celle des alertes exactes mais inutiles, d'où ces défauts.

Les seuils du cliquet des échelles fines portent une marge de 10 % sur la valeur canonique : 55 pour 50 lignes, 330 pour 300, 17 pour 15.
Une alerte à un cran du seuil canonique — 302 lignes, 51 lignes, complexité cognitive 16 — n'a jamais été jugée utile à corriger sur les cinq dépôts mesurés, la plus petite valeur utile étant au moins 40 % au-dessus.
Sur les échelles courtes, profondeur d'imbrication et nombre de paramètres, la marge tombe sous l'unité et le seuil ne bouge pas : là, le premier cran au-dessus du seuil portait bien des alertes utiles.
La complexité cyclomatique reste à son cutoff canonique de 10 : ce sont les opérateurs de valeur par défaut qui gonflaient le bas de sa distribution, et ils ne sont plus comptés.

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
- Un changement de version de crap-detector, de seuil, de périmètre ou de version d'outil rend la baseline
  incomparable : le gate échoue en demandant un nouveau snapshot, parce que ces chiffres
  ne sont réellement pas comparables.
  La version du générateur compte autant que les seuils : une définition de métrique qui change fait bouger les chiffres à seuil constant.
  Sans elle, un projet qui a épinglé ses seuils verrait une cyclomatique tombée de 17 à 5 s'afficher en amélioration, et son plancher de cliquet resterait à 17.
  Le périmètre inclut le filtrage git : une baseline écrite sans lui (hors dépôt, ou avant qu'il existe) ne se compare pas à un scan qui l'applique.
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
    "cognitiveComplexity": 17,
    "maxLinesPerFunction": 55,
    "maxFileLines": 330,
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
    "maxFilesPerCommit": 20,
    "minCoChangeCommits": 5,
    "minCoChangeDegree": 0.5,
    "minHistoryCommits": 50
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
- Un point d'entrée lancé en sous-processus, par exemple un script CLI démarré par un test
  via `spawn(['tsx', 'scripts/…'])`, reste invisible : le chemin est une chaîne de caractères,
  qu'aucun graphe d'imports ne suit. Même chose pour un fichier désigné par un alias de
  configuration (`resolve.alias` d'un `vitest.config.ts`) ou par une convention de plateforme
  (`middleware.ts` chez Vercel). À déclarer dans un `knip.json` du dépôt.
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
