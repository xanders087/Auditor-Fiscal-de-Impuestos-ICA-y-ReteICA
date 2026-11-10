# TaxFlow — Soporte para `gemini-2.5-flash`, Restauración de API Key y Optimización de Cuota

Restauración del selector completo de modelos (**`gemini-2.5-flash`**, **`gemini-3.1-flash-lite`** y **`gemini-3.5-flash`**), recuperación del campo **API Key** en el panel de Configuración y ajuste del control de reintentos en el backend para evitar el agotamiento prematuro de la cuota.

### User Review & Critical Decisions

> [!IMPORTANT]
> Se han incorporado todas las decisiones confirmadas para resolver de raíz los bloqueos de cuota (`429`).

- **Modelos Confirmados en Configuración**: Se habilitan **`gemini-2.5-flash`**, **`gemini-3.1-flash-lite`** y **`gemini-3.5-flash`** en el selector del panel de Configuración. El servidor utilizará estrictamente el modelo elegido por el usuario sin saltar a modelos no autorizados.
- **Restauración del Campo API Key**: Se restaura en el panel de **Configuración de IA** el campo de entrada de **API Key** (`id="api-key-input"`), persistido en `localStorage` y enviado al servidor en cada petición (`customApiKey`).
- **Corrección de Reintentos y Consumo de Cuota**: Se elimina el bucle de reintentos prematuros que recortaba el `retryDelay` y lanzaba hasta 4 peticiones por archivo; se restablece el comportamiento probado del servidor original (1 sola llamada limpia por PDF con pre-procesamiento OCR local sin costo de tokens y espera controlada solo cuando `retrySeconds <= 12s`).

---

### 1. Overview & Core Concept

- **Qué Hace**: Permite al usuario alternar libremente entre `gemini-2.5-flash`, `gemini-3.1-flash-lite` y `gemini-3.5-flash`, configurar su propia API Key cuando lo desee, y procesar lotes de declaraciones ICA y ReteICA con el consumo mínimo posible de peticiones y tokens.
- **Audiencia Objetivo**: Equipos de auditoría tributaria en Colombia que procesan lotes de formularios municipales en PDF o ZIP.
- **Valor Principal**: Recupera la estabilidad original frente a los límites de cuota (`RPM` y `RPD`) mientras conserva la limpieza local de dígitos separados por casillas (`6 8 0 0 0` → `68000`).

---

### 2. User Experience & Visual Design

- **Flujo de Usuario en Configuración**:
  1. Al abrir **Configuración**, el panel muestra las 3 columnas clásicas:
     - **Proveedor**: `Google Gemini AI`
     - **Modelo**: Selector con `gemini-2.5-flash`, `gemini-3.1-flash-lite` y `gemini-3.5-flash`
     - **API Key (Opcional)**: Campo de contraseña para ingresar o actualizar la clave de API en cualquier momento.
  2. Durante la auditoría de lotes, se respeta la pausa de protección de cuota de **12 segundos** entre archivos y se envía exactamente el modelo y la clave configurados.
  3. La tabla minimalista de 4 columnas (`Municipio`, `Tipo`, `Periodo`, `IA`) muestra el monto extraído y, en el tooltip, indica con exactitud qué modelo procesó el documento.

---

### 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Respetar Estrictamente el Modelo Seleccionado (`gemini-2.5-flash`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`)**
  - *Enfoque Elegido*: Pasar directamente a `ai.models.generateContent` el modelo seleccionado por el usuario en la interfaz, con `temperature: 0.0` para máxima fidelidad determinista.
  - *Por qué*: Cada modelo en Google AI maneja su propio cupo independiente; permitir cambiar a `gemini-2.5-flash` desbloquea de inmediato el procesamiento cuando otro modelo ha llegado a su tope diario.
- **Decisión 2: Eliminar Reintentos Forzados cuando el `retryDelay` Supera el Umbral**
  - *Enfoque Elegido*: Restablecer la regla original del servidor (`if (secondsToWait > 12) throw error;`) y diferenciar entre pausas breves y agotamiento de cuota diaria (`PerDay`), evitando disparar múltiples llamadas fallidas consecutivas por un mismo archivo.
  - *Por qué*: Evita que un archivo en espera vuelva a golpear la API antes de que se cumpla la ventana de enfriamiento de Google.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Diagrama de Flujo del Sistema**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         CLIENTE WEB (TaxFlow UI)                           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Panel de Configuración (3 Columnas)                                  │  │
│  │ 1. Proveedor  │ 2. Modelo (2.5-flash / 3.1-lite / 3.5) │ 3. API Key  │  │
│  └───────────────────────────────────┬──────────────────────────────────┘  │
│                                      ▼                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Cola de Procesamiento por Lotes (Intervalo de 12s entre archivos)    │  │
│  └───────────────────────────────────┬──────────────────────────────────┘  │
└──────────────────────────────────────┼─────────────────────────────────────┘
                                       │ POST /api/process-form
                                       │ { pdfBase64, fileName, model, customApiKey }
┌──────────────────────────────────────▼─────────────────────────────────────┐
│                        SERVIDOR BACKEND (Express)                          │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 1. OCR Local (pdf-parse + Unión de dígitos espaciados sin costo API) │  │
│  └───────────────────────────────────┬──────────────────────────────────┘  │
│                                      ▼                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 2. Cliente Gemini (usa customApiKey o GEMINI_API_KEY del entorno)    │  │
│  │    Llama estrictamente al `model` seleccionado (1 llamada por PDF)   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Modelo de Datos y Estado**:
  - `Configuration`: `{ provider: "gemini", model: "gemini-2.5-flash" | "gemini-3.1-flash-lite" | "gemini-3.5-flash", apiKey: string }`.
  - Se conserva la validación matemática de `total_a_pagar` vs `base_gravable` y la unión de dígitos separados por casillas.
