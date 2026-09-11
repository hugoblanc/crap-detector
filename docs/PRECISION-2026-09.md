# Précision des alertes, septembre 2026

Ce document dit ce que valent les alertes de crap-detector sur du code réel, et ce qui a changé en conséquence.
Les dépôts mesurés sont confidentiels : leur nom, leurs fichiers et leur code n'apparaissent pas ici.

## Méthode

- Cinq dépôts TypeScript réels, scannés avec les règles et les seuils par défaut de la version 0.1.
- Pour chaque règle et chaque dépôt, un échantillon de 8 alertes au plus.
- Chaque alerte est vérifiée à la main dans le code et reçoit un verdict parmi quatre : vrai-utile, vrai-inutile, faux, incertain.
- Vrai-utile : l'alerte est exacte et un développeur aurait intérêt à agir.
- Vrai-inutile : l'alerte est exacte, mais agir n'apporterait rien.
- Faux : l'alerte ne correspond pas au code, ou sa suggestion en changerait le comportement.
- Incertain : le code seul ne permet pas de trancher.
- Dans les tableaux, « exactes » compte les deux verdicts vrais, « utiles » le seul verdict vrai-utile.
- Le verdict incertain est exclu du dénominateur des pourcentages ; aucune alerte n'a été classée incertaine (0 sur 699).

## Résultats

699 alertes vérifiées, sur 25 règles, dont 80 fausses.
Globalement, 89 % sont exactes, mais 30 % seulement sont utiles.

Dix-sept règles pèsent 495 alertes et 17 faux :

| Règle | Exactes | Utiles |
| --- | --- | --- |
| assign-then-return | 100 % | 0 % |
| redundant-else | 92 % | 0 % |
| passthrough-wrapper | 65 % | 5 % |
| unused-type (knip) | 98 % | 2 % |
| nested-callbacks | 100 % | 12 % |
| boolean-ternary | 100 % | 0 % (3 alertes seulement) |
| console-only-catch | 100 % | 18 % |
| empty-catch | 96 % | 18 % |
| function-length | 100 % | 22 % |
| too-many-params | 100 % | 24 % |
| cyclomatic-complexity | 100 % | 30 % |
| file-length | 100 % | 32 % |
| type-escape-assertion | 100 % | 33 % |
| nesting-depth | 100 % | 36 % |
| type-escape-any | 100 % | 38 % |
| cognitive-complexity | 100 % | 42 % |
| duplicate-block | 100 % | 52 % |

Les huit autres, de dépendances, de graphe, de couplage et de fichiers ou exports morts, pèsent 204 alertes et 63 des 80 faux :

| Règle | Outil | Alertes | Exactes | Utiles | Faux | Traitement |
| --- | --- | --- | --- | --- | --- | --- |
| unused-file | knip | 32 | 41 % | 41 % | 19 | #9 : rapport jugé non fiable au-delà d'un tiers de fichiers inutilisés, et 10 au moins ; README sur `knip.json` (itération 2) |
| unlisted-dependency | knip | 11 | 27 % | 27 % | 8 | itération 2 (#3) : imports de types seuls avec `@types`, dédoublonnage |
| unknown-dependency | règle native | 16 | 62 % | 62 % | 6 | itération 2 (#3) : jugement contre le `package.json` le plus proche |
| unused-dependency | knip | 33 | 67 % | 67 % | 11 | #9 : écartée avec unused-file quand le rapport est jugé non fiable |
| orphan | règle native | 31 | 68 % | 48 % | 10 | itération 2 (#2) : plus de finding quand knip a tourné |
| hidden-coupling | git | 24 | 83 % | 33 % | 4 | issue #8 (en cours) |
| unused-export | knip | 40 | 88 % | 25 % | 5 | #9 : écartée avec unused-file quand le rapport est jugé non fiable |
| cycle | graphe | 17 | 100 % | 18 % | 0 | issue #7 (en cours) |

Pour les lignes corrigées par l'itération 2 ou par un travail en cours, ces chiffres sont ceux d'avant correctif : une nouvelle mesure suivra.

Ce que les verdicts disent des règles les moins utiles :

- redundant-else : aucune alerte utile, et une suggestion fausse qui changeait le comportement dans une chaîne `if / else if / else` (issue #6).
- passthrough-wrapper : 14 faux sur 40, des lambdas indispensables pour la liaison de `this`, pour l'arité transmise ou comme garde de type (issue #5).
- nested-callbacks : les callbacks imbriqués relevés sont surtout l'idiome normal de React et de zustand.
- too-many-params : les dépassements sont surtout des constructeurs d'injection de dépendances.

Pour les règles de taille et de complexité, la valeur médiane des alertes utiles est comparée à celle des alertes exactes mais inutiles, au seuil par défaut de la version 0.1 :

| Règle | Seuil | Médiane utile | Médiane inutile |
| --- | --- | --- | --- |
| function-length | 50 | 145 | 72 |
| file-length | 300 | 582 | 353 |
| cyclomatic-complexity | 10 | 33 | 15 |
| cognitive-complexity | 15 | 31 | 20 |
| nesting-depth | 3 | 5 | 4 |
| too-many-params | 4 | 6,5 | 5 |

## Limites

- Cinq dépôts seulement, tous TypeScript : rien ne dit que les proportions tiennent sur d'autres bases de code.
- Les échantillons sont petits, de 8 à 17 alertes utiles par règle de taille ou de complexité : les médianes donnent une tendance, pas une mesure fine.
- L'échantillon est plafonné par règle et par dépôt : une règle très bavarde sur un dépôt n'y pèse pas plus qu'une règle rare.
- Utile ou inutile est un jugement sur le code, pas une propriété vérifiable par un outil.
- La mesure précède les correctifs de #5 et #6, ceux de l'itération 2 et les travaux en cours sur #7 et #8 : les règles corrigées ne sont pas remesurées, une nouvelle mesure suivra.
- Les seuils de signalement retenus ne sont pas revalidés sur un nouvel échantillon.

## Décisions

### Six règles désactivées par défaut

assign-then-return, redundant-else, passthrough-wrapper, boolean-ternary, nested-callbacks et unused-type ont 12 % d'alertes utiles au plus.
Elles restent activables, une par une, par la section `rules` de `crap-detector.json`.
Désactivée, une règle n'est pas mesurée : ni finding, ni dette dans la baseline, ni lignes dans la verbosité.
Une baseline enregistre les règles optionnelles activées, et ne se compare qu'à un scan qui active les mêmes.
Une baseline antérieure, qui les comptait toutes, est incomparable et doit être refaite.

### Correctifs de justesse, même désactivées

- redundant-else ne signale un `else` que si toutes les branches précédentes de la chaîne sortent, par return, throw, continue ou break (#6).
- passthrough-wrapper ne signale plus une fonction passée en argument d'un appel, dont elle fixe le nombre d'arguments transmis, ni une fonction dont le corps appelle une méthode, qui perdrait sa liaison de `this`, ni une garde de type (#5).

### Deux niveaux pour les règles de taille et de complexité

Le seuil du cliquet ne change pas : la baseline compte exactement ce qu'elle comptait.
Un seuil de signalement, placé vers le double du seuil du cliquet, décide de ce qui s'affiche par défaut.
Ce double correspond à l'écart constaté entre les médianes utiles et inutiles.

| Règle | Cliquet | Signalement |
| --- | --- | --- |
| function-length | 50 | 100 |
| file-length | 300 | 600 |
| cyclomatic-complexity | 10 | 25 |
| cognitive-complexity | 15 | 30 |
| nesting-depth | 3 | 5 |
| too-many-params | 4 | 6 |

Entre les deux seuils, un finding est compté mais masqué du texte de `scan` et `explain`, visible avec `--all`, et marqué `belowReportThreshold` dans le JSON.
Le hook `file` ne signale que ce qui dépasse le seuil de signalement, pour ne pas interrompre un agent sur une fonction de 55 lignes.

### Pas traité dans cette itération

Les règles de catch, d'échappement de typage et de duplication restent actives et affichées telles quelles, avec 18 % à 52 % d'alertes utiles.
Les huit règles du second tableau suivent le traitement qui y est indiqué.
