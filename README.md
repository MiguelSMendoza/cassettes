# Cassettes

**Tu música digital. Dos caras. Una selección que merece grabarse.**

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.12-43853d?logo=node.js&logoColor=white)
![TypeScript estricto](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Cobertura local de líneas](badges/coverage.svg)

<!-- github-badges:start -->
[![CI](https://github.com/MiguelSMendoza/cassettes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MiguelSMendoza/cassettes/actions/workflows/ci.yml)
[![Issues abiertas](https://img.shields.io/github/issues/MiguelSMendoza/cassettes)](https://github.com/MiguelSMendoza/cassettes/issues)
<!-- github-badges:end -->

Cassettes organiza tu música para grabar casetes físicos: reparte canciones entre caras C60 o C90, cuenta las pausas y aprovecha el tiempo disponible. Escucha, ajusta la mezcla e imprime una carátula a medida, desde tu ordenador.

## Qué puedes hacer

- Organizar música de archivos y carpetas existentes, sin copiarla.
- Importar canciones y playlists de YouTube como MP3.
- Buscar y filtrar por artista, álbum o género.
- Crear playlists y preparar cintas C60 o C90 con pausas ajustables.
- Mezclar las canciones y equilibrar el tiempo entre caras.
- Añadir, quitar y reordenar canciones, o separar una cinta de una serie.
- Escuchar desde el navegador y reproducir cada cara con sus silencios.
- Imprimir carátulas con el listado de canciones y etiquetas para ambas caras.

## Instalación

Necesitas **Node.js 22.12 o superior**, npm y un navegador moderno. Para descargar desde YouTube necesitas también **Python 3.10 o superior**, disponible como `python3` y con soporte para entornos virtuales.

```sh
git clone https://github.com/MiguelSMendoza/cassettes.git
cd cassettes
npm ci
npm run setup:audio
npm run build
npm start
```

Abre **[http://127.0.0.1:4310](http://127.0.0.1:4310)**. Mantén la terminal abierta mientras usas la aplicación. Para detenerla, pulsa **Ctrl+C**; para volver a iniciarla, ejecuta `npm start`.

Puedes omitir `npm run setup:audio` si solo vas a utilizar archivos locales. La instalación necesita conexión a Internet.

## Tu primera cinta

1. En **Importar música → Archivos locales**, selecciona archivos o carpetas y pulsa **Añadir sin copiar**. También puedes pegar enlaces de YouTube y esperar a que terminen las descargas.
2. Selecciona canciones o crea una playlist. En **Mis cintas**, elige C60 o C90, las pausas y la reserva; pulsa **Organizar**.
3. Ajusta las caras con **Añadir canciones**, la **×** para quitar pistas y **Exportar caras** para separar una cinta. Pulsa **Guardar selección** para conservar las ediciones.
4. Conecta la salida del ordenador a tu grabadora, comprueba niveles y reproduce una cara. Cambia de cara manualmente: pausar la aplicación no detiene la grabadora física.
5. Descarga **Carátula PDF** e imprime al **100 % / tamaño real**, sin ajustar a página.

Puedes ajustar las pausas y dejar un margen al final de cada cara para adaptarlo a tu grabadora. Al añadir canciones, el selector muestra las que caben en el espacio disponible.

## Tu biblioteca

Los archivos importados permanecen en su ubicación original. Si los mueves o desconectas el disco donde están guardados, tendrás que actualizar su ubicación para reproducirlos.

La biblioteca y las descargas se guardan por defecto en `.data/`. Desde **Ajustes** puedes exportar el catálogo o crear una copia que incluya tu música. Exportar solo el catálogo no copia los archivos de audio.

Para cambiar el puerto o la carpeta de datos, copia `.env.example` a `.env` y ajusta sus valores.

## Créditos

Cassettes está creado por [Miguel S. Mendoza](https://github.com/MiguelSMendoza) y se distribuye bajo la [licencia MIT](LICENSE). Puedes usarlo, modificarlo y compartirlo conservando el aviso de autoría y la licencia.

Tipografía **Noto Sans**, distribuida bajo [SIL Open Font License 1.1](src/assets/fonts/OFL.txt).

## ¿Te gusta Cassettes?

Si te ha ayudado a preparar tu próxima cinta, [invítame a un café ☕](https://buymeacoffee.com/miguelsmendoza).
