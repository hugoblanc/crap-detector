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

Les règles d'échappement de typage et de duplication restent actives et affichées telles quelles, avec 33 % à 52 % d'alertes utiles.
Les huit règles du second tableau suivent le traitement qui y est indiqué.

## Itération 3 : les règles exactes et sans intérêt

Une seconde passe de vérification à la main, 497 alertes sur les mêmes cinq dépôts, donne 95 % d'exactitude pour 35 % d'utilité.
Près de 300 alertes sur 497 sont donc exactes et sans intérêt.
Trois causes en portent l'essentiel, traitées ici (issues #16 et #17).

### Les deux règles de catch jugeaient le bloc, pas ce qu'il avale

`empty-catch` était utile à 11 % et `console-only-catch` à 18 %, pour 100 % d'exactitude.
Le bloc était bien vide, mais l'échec avalé ne coûtait rien : écriture `localStorage` en navigation privée, `JSON.parse` d'une trame tierce, sélecteur CSS invalide, appel d'analytique non bloquant.
Les seules alertes jugées utiles portaient sur un appel réseau ou une écriture en base dont l'échec disparaissait en silence.

Le critère retenu est donc l'attente d'une opération asynchrone dans le `try` : c'est la marque observable d'un franchissement de frontière, et rien d'autre dans le code ne le dit.
Une fonction imbriquée dans le `try` ne compte pas, son rejet n'arrive pas à ce `catch`.

La piste « se taire quand un commentaire justifie le repli », proposée dans l'issue #16, est écartée par la mesure : les trois alertes utiles de `empty-catch` portaient toutes un commentaire de justification.
Un commentaire dit qu'une décision a été prise, pas qu'elle est bonne.

### La complexité cyclomatique comptait les valeurs par défaut

Chaque `??` et chaque `||` valait un point, alors qu'une valeur par défaut n'est pas une branche que le lecteur doit suivre.
Un opérateur logique n'est désormais compté que s'il pilote le flux : condition de `if`, de boucle, de ternaire, ou expression prise comme instruction (`prêt && envoyer()`).
Sur les cinq dépôts, 42 % des alertes de la règle tenaient à des opérateurs de valeur.

Les affectations court-circuitées `x ||= f()`, `x &&= f()`, `x ??= f()` prises comme instruction comptent désormais, elles : l'appel n'a lieu que parfois.
L'ancien calcul les ratait toutes, comparant le texte de l'opérateur aux seuls `&&`, `||` et `??`.
Effet mesuré : 6 fonctions gagnent 7 points au total sur les cinq dépôts, et une seule alerte apparaît, à 11 pour un seuil de 10.

### Les seuils frôlés

Sur les alertes classées inutiles, une part notable est à un cran du seuil : 302 lignes contre 300, 51 contre 50, complexité cognitive 16 contre 15.
Les seuils du cliquet des échelles fines portent donc une marge de 10 % : 55 lignes par fonction, 330 lignes par fichier, complexité cognitive 17.
Sur les échelles courtes — profondeur d'imbrication, nombre de paramètres — la marge tombe sous l'unité et le seuil ne bouge pas, et c'est ce que dit la mesure : 3 des 8 alertes utiles de `nesting-depth` et 2 des 8 de `too-many-params` sont exactement au premier cran.
La complexité cyclomatique garde son cutoff de 10 : le bas de sa distribution était gonflé par les opérateurs de valeur, que le calcul ne compte plus, et la majorer en plus coûtait une alerte utile de l'échantillon pour quatre inutiles.

Une marge n'est pas un troisième niveau de seuil : elle est intégrée aux défauts de `thresholds`, qui restent réglables par projet.

### Ce que ça donne

Rescan des cinq dépôts, alertes des huit règles concernées, et verdicts humains des alertes échantillonnées :

| Règle | Alertes avant | Après | Échantillon : utiles perdues | inutiles retirées |
| --- | --- | --- | --- | --- |
| cyclomatic-complexity | 965 | 557 | 2 | 14 |
| cognitive-complexity | 744 | 612 | 0 | 7 |
| function-length | 1734 | 1511 | 0 | 9 |
| file-length | 330 | 285 | 0 | 8 |
| nesting-depth | 350 | 350 | 0 | 0 |
| too-many-params | 114 | 114 | 0 | 0 |
| empty-catch | 80 | 36 | 0 | 16 |
| console-only-catch | 11 | 9 | 1 | 1 |
| **total** | **4328** | **3474** | **3** | **55** |

Sur l'échantillon vérifié à la main de ces huit règles, l'utilité passe de 28 % (76 utiles sur 268) à 35 % (73 sur 210).
Une baseline écrite avant ce changement n'est plus comparable : la version du générateur entre dans le jugement de comparabilité, précisément parce qu'un projet aux seuils épinglés verrait sinon la chute des chiffres en amélioration.

Chiffres repris après la fusion des règles d'imports et de code mort de l'itération suivante : les huit règles ci-dessus ont exactement la même population qu'avant cette fusion, qui ne touche ni les métriques ni les règles de catch.
Sur l'ensemble des règles, les cinq dépôts passent de 6833 alertes à 6581 par cette fusion, puis à 5727 par les changements décrits ici.

Les trois alertes utiles perdues :

- une fonction de page dont la cyclomatique tenait aux valeurs par défaut du rendu ; `function-length` la signale toujours, à 276 lignes, et au-dessus du seuil de signalement.
  Sa `cognitive-complexity` vaut 18 pour un seuil qui vient de passer à 17 : une marge arrondie à 18 au lieu de 17 rendrait cette perte sèche, à ne pas arrondir vers le haut sans le savoir ;
- un comparateur de tri dont la cyclomatique tombe de 16 à 8 une fois les `|| 0` retirés ; `cognitive-complexity` signale toujours la méthode qui le contient, à 23 ;
- un `catch` de constructeur qui logue une chaîne d'accès de propriétés en échec, sans opération asynchrone : le défaut réel, un objet à moitié construit rendu sans erreur, n'est pas ce que la règle mesure, et rien ne le signale plus.

`console-only-catch` reste active malgré ses 11 % d'utilité après restriction : ses 9 alertes restantes sur cinq dépôts ne pèsent rien, et la désactiver par défaut coûtait deux alertes utiles pour neuf inutiles.

### Ce qui reste ouvert

- Le critère asynchrone laisse passer toute une famille, absente de l'échantillon : le repli synchrone qui avale une erreur d'infrastructure.
  Lecture de configuration par `readFileSync`, écriture d'un fichier d'audit par `writeFileSync`, `execSync` d'une migration, insertion par un pilote de base synchrone : construits en fixture, aucun de ces cas n'est plus signalé, et ce sont exactement les erreurs que visait l'issue #16.
  Les cinq dépôts mesurés sont des applications web et des API, où l'entrée-sortie est asynchrone ; la classe de code où cette famille vit, outillage en ligne de commande et scripts de build, n'y est pas représentée.
  Aucun des 46 blocs `catch` que le changement fait taire ne porte de marqueur d'entrée-sortie synchrone : le critère n'est donc pas réfuté par la mesure, il n'est pas non plus vérifié sur cette classe de dépôts.
- Le cas « l'échec est déjà traité après le `try` » n'est pas détecté : deux alertes de `console-only-catch` portent sur un envoi d'e-mail dont l'échec est marqué en base juste après le bloc.
- Les `catch` de scripts ponctuels et d'évaluations comptent comme ceux du code de production : quatre alertes restantes en viennent.
- Les seuils de `nesting-depth` et `too-many-params` restent les plus bruyants des règles de taille, à 21 % et 24 % d'utilité, sans correctif dans cette itération.
