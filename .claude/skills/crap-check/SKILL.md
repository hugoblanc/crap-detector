---
name: crap-check
description: Vérifie qu'un changement n'aggrave aucune métrique de qualité avant de rendre le travail. À utiliser en fin de tâche sur un dépôt qui contient un crap-detector-baseline.json, ou quand l'utilisateur demande de vérifier la qualité, la complexité, la duplication, le code mort ou la dette d'un changement.
---

# Vérifier un changement avec crap-detector

Cette procédure existe parce qu'une consigne de style ne marche pas.
SlopCodeBench a mesuré qu'une intervention par prompt du type « écris du code propre »
n'abaisse que le point de départ : elle ne ralentit pas la dégradation, n'améliore pas
les taux de réussite et ne réduit pas le coût.
Seule une commande qui échoue change quelque chose.

## Procédure

1. **Lancer le cliquet.**

   ```
   crap-detector check
   ```

   Sortie 0 : rien ne s'est aggravé, le travail peut être rendu.
   Sortie 1 : au moins une métrique a empiré par rapport à la baseline commitée.
   Sortie 3 : la baseline est absente ou illisible, voir la section « baseline » plus bas.

2. **Lire les régressions.** Elles ont quatre formes :

   - `aggregate` : une métrique globale a monté (érosion, verbosité, duplication, cycles…).
   - `debt-new-file` : un fichier jusque-là propre viole maintenant une règle.
   - `debt-new-entry` : un fichier déjà en dette viole une règle supplémentaire.
   - `debt-increase` : le nombre de violations d'une règle existante a augmenté.

3. **Corriger, ne pas contourner.** Les régressions `debt-new-file` et `debt-new-entry`
   viennent presque toujours du code qu'on vient d'écrire. Les corriger est le travail.

4. **Relancer** `crap-detector check` jusqu'à obtenir la sortie 0.

## Comprendre un fichier en particulier

```
crap-detector explain src/chemin/fichier.ts
```

Rend les métriques du fichier, son score de hotspot et la liste de ce qui lui est reproché.

## Ce qu'il ne faut pas faire

- **Ne pas refaire la baseline pour faire passer le gate.**
  `crap-detector baseline` fige l'état courant comme nouveau plancher : lancé pour
  masquer une régression, il transforme la dette ajoutée en dette acceptée.
  Ne le lancer que si la sortie dit explicitement que la baseline est incomparable
  (changement de seuil, de périmètre, de règles activées ou de version d'outil), ou si l'utilisateur le demande.

- **Ne pas découper une fonction uniquement pour passer sous un seuil.**
  L'outil suit `functionsPerFile` et `medianFunctionSloc` précisément pour ça :
  saucissonner fait monter le premier et chuter le second, sans rien améliorer.

- **Ne pas ajouter `any`, `as unknown as`, `@ts-ignore` ni un `catch` vide** pour
  faire taire une erreur. Ce sont des règles à part entière, elles seront détectées.

## Si la baseline n'existe pas

Sur un dépôt qui n'en a jamais eu, la créer une fois et la commiter :

```
crap-detector baseline
```

C'est ce fichier qui rend la CI incrémentale : la dette existante devient de la dette
figée au lieu de dette croissante.
