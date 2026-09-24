# Radar NCAAF

Web que muestra los partidos de fútbol americano universitario de la semana con datos
de TeamRankings.com: posición en su conferencia, % de victorias y racha; puntos,
touchdowns ofensivos, yardas por punto y yardas por juego (local en casa / visita fuera);
3 marcadores posibles, total de puntos y hándicap (spread). Incluye buscador por equipo
o conferencia y filtro "Solo con datos" para ocultar partidos contra equipos FCS.

## Estructura
- `public/index.html` — la página
- `netlify/functions/ncaaf.mjs` — lee TeamRankings y entrega `/api/ncaaf`
- `netlify.toml` — configuración de Netlify (no cambiar)

## Publicar
1. Crear repositorio nuevo en GitHub y subir arrastrando las carpetas `public` y `netlify`
   más los archivos `netlify.toml`, `package.json` y `README.md`. No hace falta main.yml.
2. Netlify → Add new site → Import from GitHub → elegir el repositorio → Deploy.
