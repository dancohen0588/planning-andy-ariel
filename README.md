# Planning Andy & Ariel 2026-2027

Site + calendriers iPhone auto-mis à jour (abonnement `webcal://`), hébergés sur **GitHub Pages**.

## Architecture : un seul fichier, plusieurs portes d'entrée

```
                 ┌──────────────┐
  Claude ──────▶ │              │
  GitHub (web/   │ data/        │   push    ┌──────────────────┐   ┌─────────────────────┐
  app mobile) ─▶ │ planning.json│ ────────▶ │ GitHub Action    │ ▶ │ GitHub Pages        │
  Interface      │              │           │ node build.js    │   │ index.html          │
  future ──────▶ │ (via         │           │ (≈ 40 s)         │   │ feeds/*.ics (×6)    │
  (formulaire,   │  update.js)  │           └──────────────────┘   └──────────┬──────────┘
   raccourci…)   └──────────────┘                                              │ webcal://
                                                                       iPhones abonnés
```

- `data/planning.json` — **la seule source de vérité** (vacances, activités, gardes, absences)
- `update.js` — API en ligne de commande pour modifier le JSON sans erreur (voir plus bas)
- `build.js` — génère `dist/` : le site + 6 flux `.ics` personnalisés
- `.github/workflows/deploy.yml` — à chaque modification, reconstruit et publie automatiquement
- `src/index.template.html` — template du site
- `netlify.toml` — conservé au cas où (le projet se déploie aussi sur Netlify/Cloudflare tel quel)

## Mise en place (une seule fois, ~10 min)

1. **Créer le dépôt** sur github.com → *New repository* → nom `planning-andy-ariel`.
   ⚠️ GitHub Pages sur un dépôt **privé** nécessite GitHub Pro (4 $/mois). Sur un dépôt public c'est gratuit, mais le JSON (écoles, adresses, téléphone) sera lisible par tous. Alternative gratuite avec dépôt privé : Cloudflare Pages (build `node build.js`, dossier `dist`).
2. **Envoyer les fichiers** : *Add file → Upload files* → glisser tout le contenu de ce dossier (y compris le dossier caché `.github`) → *Commit*.
3. **Activer Pages** : *Settings → Pages → Build and deployment → Source :* **GitHub Actions**.
4. Aller dans l'onglet *Actions* : le workflow tourne (≈ 40 s). L'URL du site s'affiche : `https://<votre-compte>.github.io/planning-andy-ariel/`
5. Donner à chacun son lien : onglet « 📲 S'abonner » du site, ou directement
   `webcal://<votre-compte>.github.io/planning-andy-ariel/feeds/<parents|andy|ariel|younette|mamimo|diane>.ics`

Les abonnés Netlify existants devront se réabonner avec la nouvelle adresse (une fois).

## Mettre à jour le planning (au quotidien)

Toute modification de `data/planning.json` poussée sur `main` déclenche le build + la publication. Les iPhones se mettent à jour à leur prochain rafraîchissement (régler « toutes les heures » : *Réglages → Apps → Calendrier → Comptes → Calendriers abonnés*).

### Porte 1 — depuis Claude
Connecter le connecteur **GitHub** dans Claude, puis demander en langage naturel : « ajoute Mamimo le mercredi 7 octobre », « Younette absente du 20 au 27 décembre »… Claude modifie `planning.json` (idéalement via `update.js`) et commit ; le reste est automatique.

### Porte 2 — depuis GitHub (ordinateur ou app mobile)
Ouvrir `data/planning.json` → ✏️ → modifier → *Commit changes*. Une erreur de syntaxe fait échouer le build (mail de GitHub) sans casser le site en ligne.

### Porte 3 — en ligne de commande / par un script
```
node update.js garde 2026-10-07 mamimo
node update.js garde-supprimer 2026-10-14
node update.js absence younette 2026-12-20 2026-12-27 "Younette à Marrakech"
node update.js vacances ariel 2027-05-14 2027-05-14 "Pont"
node update.js activite-horaire andy 3 "Graphologie" 14h30 15h10
node update.js liste          # mercredis encore à définir
```
puis `git commit && git push`.

### Porte 4 — interface pour la famille (à venir)
Le workflow accepte aussi un déclenchement externe (`repository_dispatch`, type `rebuild`) et un bouton *Run workflow*. Toute interface capable d'écrire dans `planning.json` via l'API GitHub (ou de lancer `update.js`) fonctionne : formulaire GitHub Issues + Action, raccourci iPhone, n8n, Notion/Google Sheet synchronisé…

## Contenu des flux

| Flux | Contenu |
|---|---|
| parents | Tout : vacances des deux enfants, activités, mercredis de garde, sorties d'école par Diane, alertes « garde à définir », absences des adultes |
| andy / ariel | Vacances + activités de l'enfant, mercredis de garde, sorties d'école le concernant |
| younette / mamimo | Leurs mercredis de garde (11h-17h) avec le programme chronologique de la journée (sorties d'école, activités, adresses, contacts), vacances des enfants, leurs absences |
| diane | Sorties d'école lundi & jeudi (uniquement l'enfant qui a classe ; rien si les deux sont en vacances), mercredis de garde éventuels, vacances des enfants |

Les activités ne sont pas générées les jours de vacances de l'enfant. Rappels : 30 min avant (activités), 1 h avant (sorties d'école), la veille (garde du mercredi).

## Limites GitHub Pages (plan gratuit / Pro)
100 Go de bande passante par mois (souple), 1 Go de site, pas de compteur de minutes de build, pas de facturation au dépassement. Usage de ce projet : < 1 Go/mois.
