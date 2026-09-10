---
name: crap-hotspot
description: Décide par où commencer un refactoring en croisant l'historique git et la complexité. À utiliser quand l'utilisateur demande par où attaquer la dette, quoi refactorer en premier, où est le pire du code, ou quand une tâche de nettoyage n'a pas de cible précise.
---

# Choisir où refactorer

Un hotspot est du code compliqué **et** souvent modifié.
La complexité seule ne dit rien : un parseur figé depuis trois ans peut être illisible
sans coûter un centime. C'est le croisement avec la fréquence de changement qui
identifie l'endroit où la dette se paie réellement (Tornhill, *Software Design X-Rays*).

## Procédure

1. **Classer.**

   ```
   crap-detector hotspots --top 10
   ```

   Le score vaut `commits × max(complexité cyclomatique, complexité cognitive)` sur la
   fenêtre d'historique configurée (un an par défaut).

2. **Prendre le premier, pas le plus laid.** L'ordre de la liste est l'ordre de travail.
   Un fichier très complexe absent du haut de la liste ne bouge pas : il ne coûte rien.

3. **Comprendre avant de toucher.**

   ```
   crap-detector explain <fichier>
   ```

   Donne les fonctions fautives, leurs métriques et le score de hotspot du fichier.

4. **Vérifier le couplage caché.** Le rapport complet (`crap-detector scan --json`)
   contient une section `coupling` : les paires de fichiers qui changent toujours
   ensemble **sans import entre eux**. Si le hotspot visé apparaît dans une de ces
   paires, refactorer l'un sans l'autre laissera le lien implicite en place.

5. **Ne pas sortir de la liste.** Tant que les hotspots du haut ne sont pas traités,
   refactorer ailleurs consomme du budget sans réduire le coût de la dette.

## Si la liste est vide

Le message « aucun hotspot » signifie qu'aucun historique git n'est exploitable :
dépôt non initialisé, fenêtre trop courte, ou aucun fichier du périmètre modifié
sur la période. Vérifier avec `git log --oneline -5` avant de conclure quoi que ce soit
sur la santé du code.
