# CSS Cleaner

CSS Cleaner est un projet de CLI qui aide à nettoyer progressivement les styles d’une application React, avec ou sans Next.js. Son objectif est de repérer les classes probablement inutilisées et les références à des styles manquants, puis d’indiquer où vérifier chaque résultat avant de modifier le code.

**État du projet** — Le socle TypeScript est en développement. Les fonctionnalités décrites ci-dessous constituent le périmètre du MVP. [Suivre l’avancement sur GitHub](https://github.com/dokor/css-cleaner/issues/9).

## Ce que l’outil analysera

- **Styles** — CSS, SCSS et Sass indenté, en fichiers globaux ou en CSS Modules (`.module.css`, `.module.scss`, `.module.sass`). L’analyse couvrira les sélecteurs composés et les variantes BEM imbriquées.
- **Composants React** — Classes écrites dans `className`, accès comme `styles.title`, conditions, appels à `clsx` ou `classnames` et chaînes de caractères interpolées.
- **Portée des noms** — Une référence à `styles.title` sera recherchée dans le module importé par le composant. Une classe homonyme dans un autre module ne pourra pas masquer une faute.

## Exemple de diagnostic

Si un composant construit une classe avec `button--${variant}`, l’analyse pourra rapprocher ce motif de `.button--primary` et `.button--secondary`. Le rapport les présentera comme des candidates à vérifier. À l’inverse, si le composant lit `styles.primray` et que son module déclare seulement `.primary`, le rapport signalera l’accès manquant et sa ligne dans le composant.

## Utilisation prévue

La commande prévue est `css-cleaner scan .`, depuis la racine du projet. Elle analysera les sources en lecture seule, sans démarrer de serveur ni compiler l’application. Le MVP sera validé sur deux projets témoins, l’un sous Next.js et l’autre sous React avec Vite.

Le rapport regroupera les classes probablement inutilisées, les usages introuvables et les usages dynamiques à vérifier. Chaque diagnostic précisera son emplacement, sa raison et son niveau de confiance. Les formats prévus sont le terminal, JSON et Markdown. En CI, l’option `--fail-on-missing` permettra de faire échouer le contrôle sur les classes manquantes à confiance élevée.
