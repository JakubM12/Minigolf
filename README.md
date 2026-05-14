# Minigolf

Jednoducha browser hra pripravena pro GitHub Pages.

## Spusteni lokalne

Otevri `index.html` v prohlizeci.

## Nasazeni na GitHub Pages

Projekt je pripraveny na automaticky deploy pres GitHub Actions.

1. Vytvor na GitHubu novy repozitar.
2. Pridej ho jako remote:

```powershell
git remote add origin https://github.com/TVUJ-UCET/TVUJ-REPO.git
```

3. Commitni a pushni projekt:

```powershell
git add .
git commit -m "Prepare minigolf for GitHub Pages"
git push -u origin master
```

4. Na GitHubu otevri `Settings -> Pages`.
5. V sekci `Build and deployment` nastav `Source` na `GitHub Actions`.
6. Po prvnim pushi se spusti workflow `Deploy To GitHub Pages`.
7. Hotova hra bude na adrese:

```text
https://TVUJ-UCET.github.io/TVUJ-REPO/
```

## Poznamka

Workflow nasazuje cely obsah repozitare jako staticky web, takze vsechny `.html`, `.css`, `.js` a `.wav` soubory budou fungovat bez dalsi konfigurace.
