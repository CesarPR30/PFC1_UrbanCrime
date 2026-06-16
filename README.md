# Urban Crime Dashboard — Comparación de subgrafos urbanos topológicamente similares

Dashboard de apoyo al paper: *diseño comparativo entre zonas urbanas topológicamente
similares* sobre el dataset de crímenes de Chicago. La pregunta de investigación es si la
**topología de la red vial** y los **POIs (uso de suelo)** influyen en la criminalidad:
si la zona A se parece estructuralmente a B pero A tiene más crímenes, ¿qué diferencia
funcional (p. ej. B tiene bancos) podría explicarlo?

## Flujo de uso

1. **Seleccionar un subgrafo** en el scatter UMAP (sidebar izquierdo) o en el mapa
   (botón "Mostrar hotspots"). El mapa vuela a la zona.
2. El sidebar muestra el **subgrafo de referencia (A)**, su **evolución histórica de
   crímenes** y la lista de **subgrafos con topología más parecida**.
3. Pulsar **"vs"** en un similar abre la **comparación A vs B**: delitos (total, delta %,
   serie mensual de ambos footprints) contra POIs (barras espejadas por categoría, con
   las categorías exclusivas marcadas como *"solo A" / "solo B"* — el candidato más
   directo a explicar una brecha de criminalidad entre gemelos topológicos).
4. La herramienta **Lazo** del UMAP selecciona grupos completos y los resalta en el mapa.
5. Para validación, el mapa conserva los **datos en crudo**: puntos de crimen, heatmap,
   mapa de nodos del street network, subgrafos y POIs.

## Pipeline de datos

```
public/crimes.csv ──► preprocess_hotspots.py ──► public/hotspots.json
                          │  (pipeline completo: descarga red vial OSM,
                          │   hotspots, similitud, POIs, embeddings, historia)
                          │
                      embed_subgraphs.py
                          (re-cálculo rápido de embeddings + historia SIN
                           re-descargar la red; reusa los edges ya guardados)

build_nodes.py ──► public/nodes.json   (conteos de crimen por nodo vial)
```

Para regenerar solo embeddings/series históricas: `python embed_subgraphs.py`.

### Extracción de subgrafos (hotspots)

Por mes: cada crimen se asigna a su nodo vial más cercano; un BFS codicioso desde los
nodos con más crímenes crece a través de la red vial recolectando nodos con crimen,
pudiendo *puentear* hasta 1 intersección sin crimen (sin el puente, una esquina vacía
fragmentaba concentraciones reales — validado contra el heatmap). Se conservan los
**top-20 subgrafos por mes** (480 en total, 24 meses).

### POIs

Descargados de OpenStreetMap (Overpass) y agregados a 8 categorías (comida, vida
nocturna, educación, salud, policía, finanzas, retail, parque). Se asignan a cada
subgrafo por contención en el casco convexo de sus nodos (con buffer).

## Decisiones de diseño (y por qué)

### 1. ¿Qué entra en el embedding del UMAP? → solo la red vial (forma + tipo de vía)

El embedding se construye **únicamente con la red vial**: la *forma* del subgrafo y la
*jerarquía de sus calles* (autopista / avenida / colectora / calle / servicio). Ni el
crimen, ni los POIs, ni la historia entran al layout (siguen guardados para los gráficos
laterales). Así el crimen, que es la **variable resultado**, nunca forma los grupos: que
dos vecinos del scatter difieran en criminalidad **es un hallazgo**, no una contradicción
de construcción.

| Espacio (botón) | Campo JSON | Bloques | Para qué sirve |
|---|---|---|---|
| **Topología** | `embedTopo` | NetLSD + stats estructurales + geometría | Solo la *forma* de la red vial, sin distinguir tipo de calle. |
| **+Vía** (default) | `embed2d` | topología + tipo de vía | Forma + jerarquía vial. Dos cuencas con la misma forma pero hechas de avenidas vs. calles residenciales se separan — que es lo que el analista ve en el mapa. |

Complemento clave: el toggle de color **"Nº delitos"** (rampa secuencial). Con color =
Nº delitos se *ve* directamente si zonas estructuralmente parecidas comparten nivel de
criminalidad — la pregunta del paper en un solo encuadre.

### 2. Topología: NetLSD (heat-kernel trace), no conteos crudos

Los subgrafos van de 1 a ~63 nodos; con node/edge counts el tamaño domina cualquier
distancia. La traza del kernel de calor del Laplaciano normalizado
(Tsitsulin et al., *NetLSD: Hearing the Shape of a Graph*, KDD 2018) es invariante a
permutación y (normalizada por n) comparable entre tamaños, y muestreada en 16 escalas
log-espaciadas captura estructura local→global. Se conservan además log-tamaño, densidad
y grado medio como features interpretables. Se descartó graph2vec: necesita un corpus
grande y degrada en grafos tan pequeños.

### 3. Historia: descriptor temporal del *footprint*, y la serie cruda para la UI

Para el bloque histórico del embedding se resume la serie mensual del footprint en
5 features (z-score del mes vs. su propia historia, volatilidad, tendencia, persistencia,
nivel). Además ahora se exporta la **serie cruda** (`history`, alineada con los meses
ordenados del dataset) para que el frontend grafique *cómo varió el crimen en esa zona a
lo largo del histórico* al seleccionarla — incluida la superposición de la serie del
subgrafo comparado y de los similares como contexto.

### 4. POIs: bag-of-categories + densidad + entropía

Siguiendo la línea de *urban functional zones*: distribución normalizada sobre
categorías POI + densidad (POIs/nodo) + diversidad (entropía normalizada). Da a cada
zona una huella de uso de suelo de longitud fija.

### 5. Fusión y proyección

Cada bloque se estandariza por separado (z-score por columna) y se pondera antes de
concatenar — evita que un bloque domine por dimensionalidad o escala (el espectral tiene
16 dims; la mezcla de delitos, 4). Proyección con **UMAP** (métrica coseno,
`n_neighbors=15`, semilla fija para reproducibilidad); fallback a PCA si umap-learn no
está disponible. UMAP preserva vecindarios locales, que es exactamente lo que hace
legible el scatter como "grupos de subgrafos parecidos".

### 6. Lista de similares: similitud topológica explícita

El ranking "similarTo" (top-5) usa similitud coseno sobre un vector topológico de 10
dims — deliberadamente **solo topología**, consistente con el espacio default del UMAP y
con la definición de "gemelo" del paper. El embedding 2-D es para *ver* la estructura
global; el ranking es para *navegar* pares concretos.

### 7. Comparación A vs B (núcleo del diseño comparativo)

- Tarjetas lado a lado (glifo del subgrafo, total de delitos, nodos, POIs) + titular con
  el delta porcentual de crímenes.
- Series históricas de ambos footprints superpuestas (mismo eje), con marcador del mes
  en que cada subgrafo fue detectado.
- Barras espejadas por tipo de delito y por categoría POI: A crece hacia la izquierda,
  B hacia la derecha, misma escala → la asimetría se lee de un vistazo.
- Categorías POI presentes en solo una de las dos zonas se resaltan ("solo A"/"solo B"):
  es la evidencia más accionable del tipo *"B tiene bancos y menos crímenes"*.

### 8. Validación con datos en crudo

Se mantienen deliberadamente las vistas de bajo nivel (puntos de crimen, heatmap,
mapa de nodos con conteos por intersección, subgrafos y POIs sobre el mapa real) para
que cualquier patrón visto en el espacio abstracto del UMAP pueda contrastarse contra
los datos originales georreferenciados.

## Estructura del código

```
components/
  UmapPanel.tsx     scatter UMAP: espacios de embedding, color tipo/nº delitos, lazo
  HistoryPanel.tsx  serie mensual del footprint (selección + comparación + similares)
  ComparePanel.tsx  comparación A vs B: delitos vs POIs, barras espejadas
  Sidebar.tsx       referencia, similares (botón "vs"), orquesta los paneles
  CrimeMap.tsx      deck.gl: puntos, heatmap, nodos, subgrafos, POIs
  SubgraphGlyph.tsx mini-dibujo normalizado de la forma del subgrafo
store/useHotspotStore.ts  selección, comparación, lazo, fly-to (zustand)
preprocess_hotspots.py    pipeline completo (red OSM + hotspots + embeddings)
embed_subgraphs.py        re-cálculo de embeddings/historia sin re-descargar la red
```

## Ejecutar

```bash
npm install
npm run dev        # requiere VITE_MAPBOX_TOKEN en .env
npm run build      # tsc + vite build

# regenerar datos (Python 3.13: pandas, numpy, scipy, umap-learn; osmnx solo
# para el pipeline completo)
python preprocess_hotspots.py   # todo desde cero (descarga red vial + POIs)
python embed_subgraphs.py       # solo embeddings + series históricas
```
