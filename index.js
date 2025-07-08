#!/usr/bin/env node
'use strict'

import { execSync } from "child_process";
import axios from "axios";
import inquirer from "inquirer";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import path from "path";
import * as dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import { getArgs, checkGitRepository } from "./helpers.js";

dotenv.config();

const args = getArgs();
const REGENERATE_MSG = "♻️ Regenerar mensajes";
const QWEN_MODEL = "qwen/qwen3-30b-a3b";
const ENV_VAR_NAME = "OPENROUTER_API_KEY";
const CONFIG_PATH = path.join(homedir(), ".commitconfig.json");

// Cargar la clave desde JSON local
function loadApiKeyFromJson() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      return config[ENV_VAR_NAME];
    } catch {
      return null;
    }
  }
  return null;
}

// Guardar la clave en JSON local
function saveApiKeyToJson(apiKey) {
  const config = { [ENV_VAR_NAME]: apiKey };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  console.log(`✅ Clave guardada en ${CONFIG_PATH}`);
}

// Obtener la API Key
let OPENROUTER_API_KEY = process.env[ENV_VAR_NAME] || loadApiKeyFromJson();

if (!OPENROUTER_API_KEY) {
  const askForApiKey = async () => {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: '🔑 Ingresa tu API key de OpenRouter:',
        mask: '*',
        validate: input => input.length > 10 || 'Debe ser una clave válida',
      },
    ]);

    saveApiKeyToJson(apiKey);
    OPENROUTER_API_KEY = apiKey;
  };

  await askForApiKey();
}

console.log("API Key:", OPENROUTER_API_KEY ? "✅ Encontrada" : "❌ No encontrada");
if (!OPENROUTER_API_KEY) {
  console.error("⚠️ Debes configurar la variable OPENROUTER_API_KEY");
  process.exit(1);
}

const makeCommit = (title, body = "") => {
  console.log("Creando commit... 🚀");
  const message = body ? `${title}\n\n${body}` : title;
  const tmpFilePath = path.join(tmpdir(), 'commit-msg.txt');
  writeFileSync(tmpFilePath, message, 'utf8');
  execSync(`git commit --file="${tmpFilePath}"`, { stdio: 'inherit' });
  unlinkSync(tmpFilePath);
  console.log("✅ Commit creado exitosamente");
};

async function callQwenAPI(prompt) {
  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: QWEN_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Eres un experto en mensajes de commit en español. Sigue estas reglas:\n" +
              "1. Título conciso (máx 50 caracteres)\n" +
              "2. Cuerpo explicativo obligatorio\n" +
              "3. Usa formato: '<tipo>: <descripción>'\n" +
              "4. Lenguaje claro y técnico con viñetas\n" +
              "5. Nunca incluyas 'Resuelve #123' o referencias similares a issues"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com",
          "X-Title": "AI Commit"
        },
        timeout: 20000
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error("Error en la API:", error.response?.data || error.message);
    process.exit(1);
  }
}

const generateCommit = async (diff) => {
const prompt =
`Genera EXACTAMENTE 1 mensaje de commit profesional con estas REGLAS ABSOLUTAS:

--- FORMATO EXACTO ---
<tipo>: <título en español (max 50 chars, sin acentos)>
* <viñeta 1 en infinitivo (español) - cambio principal OBLIGATORIO>
* <viñeta 2 - cambio secundario RELEVANTE si aplica>
* <viñeta N - detalles técnicos adicionales NECESARIOS>

--- TIPOS PERMITIDOS (SOLO ESTOS) ---
feat    - Nueva funcionalidad (usar "feat" pero descripción en español)
fix     - Correccion de errores
docs    - Documentacion
style   - Formato/estructura
refactor- Reestructuracion sin cambiar funcionalidad
perf    - Mejora de rendimiento
test    - Pruebas
chore   - Mantenimiento
build   - Sistema de compilacion
ci      - Integracion continua
revert  - Revertir cambios

--- REGLAS DE ESCRITURA ---
1. TITULO:
   - Español obligatorio (ni una palabra en inglés)
   - Sin acentos ni caracteres especiales
   - Maximo 50 caracteres
   - Sin puntos finales
   - Especificar componente afectado (ej: "en modulo X")

2. CUERPO (VIÑETAS):
   * PRIMERA VIÑETA: Cambio principal (OBLIGATORIA)
     - Verbo en infinitivo técnico (implementar, corregir, optimizar)
     - Explicar QUÉ y POR QUÉ (no solo "cambiar X")
   * VIÑETAS ADICIONALES: 
     - Solo si aportan contexto técnico relevante
     - Cada una debe ser autocontenida y clara
     - No usar viñetas redundantes o genéricas
     - Priorizar orden lógico (ej: flujo de datos -> validación -> UI)

3. PROHIBIDO:
   - Viñetas genéricas ("actualizar código", "fix cosas")
   - Mencionar archivos sin contexto ("modificar api.js")
   - Mezclar tipos de cambios (ej: "fix" y "feat" juntos)
   - Usar inglés ("bug", "hotfix", "refactor")

--- EJEMPLO VALIDO (CON VIÑETAS EXTENDIDAS) ---
feat: Agregar validacion en formulario de pago
* Implementar chequeo de tarjeta con Luhn
* Añadir mensajes de error contextuales
* Integrar con servicio de antifraude
* Actualizar tests de integracion
* Optimizar tiempo de respuesta en validacion

--- CAMBIOS A DOCUMENTAR ---
${diff}

Genera EXACTAMENTE 1 commit que:
1. Use tantas viñetas como cambios técnicos relevantes haya
2. Cada viñeta explique un aspecto CONCRETO (no agrupar)
3. Mantenga coherencia con el tipo de commit
4. Sea 100% en español técnico claro y preciso`;

  let attempts = 0;
  let title = "", body = "";

  while (attempts < 3) {
    const fullMessage = await callQwenAPI(prompt);
    const [firstLine, ...rest] = fullMessage.split('\n').filter(Boolean);
    title = firstLine.trim();
    body = rest.join('\n').trim();

    const commitType = title.split(':')[0].trim();
    const validTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci', 'revert'];

    if (body.length > 0 && validTypes.includes(commitType)) {
      return { title, body };
    }

    console.warn(`⚠️ Intento ${attempts + 1}: mensaje no cumple formato, reintentando...`);
    attempts++;
  }

  console.error("❌ No se pudo generar un mensaje válido después de 3 intentos.");
  process.exit(1);
};

const generateListCommits = async (diff, numOptions = "N") => {
const prompt = `Genera EXACTAMENTE ${numOptions} opciones de mensajes de commit SEMÁNTICOS en ESPAÑOL para estos cambios:

--- REGLAS ESTRICTAS (ESPAÑOL OBLIGATORIO) ---
1. TIPOS PERMITIDOS (SOLO ESTOS):
   • feat:     Nueva funcionalidad
   • fix:      Corrección de error
   • docs:     Cambios en documentación
   • style:    Formato/estructura (sin lógica)
   • refactor: Reestructuración sin funcionalidad
   • perf:     Mejora de rendimiento
   • test:     Pruebas automatizadas
   • chore:    Mantenimiento
   • build:    Dependencias/compilación
   • ci:       Integración continua
   • revert:   Revertir cambios

2. ESTRUCTURA OBLIGATORIA:
   <tipo>(<ámbito>): <título (50 chars max)>
   * Verbo en infinitivo (español)
   * Descripción específica (todas las viñetas necesarias)
   * Sin nombres de archivos sin contexto
   * Cada viñeta explica un cambio concreto

3. PROHIBIDO ABSOLUTO:
   • Títulos genéricos ("arreglar cosas")
   • Términos en inglés ("bug", "fix", "hotfix")
   • Viñetas que no empiecen con verbo
   • Mezclar idiomas en descripciones
   • Usar "código", "archivo" o términos vagos

--- EJEMPLO PERFECTO ---
feat(autenticacion): implementar login biometrico
* Añadir soporte para huella digital en iOS
* Integrar API de FaceID para Apple
* Implementar autenticacion con rostro en Android
* Crear componente reusable para validacion
* Añadir tests E2E para flujo biometrico
* Documentar metodos expuestos

--- CAMBIOS A COMMITIR ---
${diff}

--- REQUISITOS FINALES ---
Genera ${numOptions} opciones que:
1. Usen español 100% (sin excepciones)
2. Sean atomicas (1 funcionalidad/logica por commit)
3. Incluyan todas las viñetas necesarias para explicar COMPLETAMENTE el cambio
4. Usen ambitos cuando corresponda (ej: "(API)", "(UI)")
5. Prioricen claridad sobre brevedad en el cuerpo

--- BUENAS PRÁCTICAS ---
• Ordenar viñetas por importancia
• Agrupar cambios relacionados
• Explicar el "qué" y "por qué" (no el "cómo")
• Usar verbos fuertes: implementar, corregir, optimizar, eliminar
• Incluir impactos relevantes (ej: "Aumenta rendimiento en 40%")`;
  const response = await callQwenAPI(prompt);
  return response.split('\n')
    .filter(opt => opt.includes('|||'))
    .map(opt => {
      const [title, body] = opt.split('|||');
      return {
        title: title.trim(),
        body: body?.trim() || ""
      };
    });
};

const runInteractive = async () => {
  if (!checkGitRepository()) {
    console.error("⚠️ No es un repositorio Git");
    process.exit(1);
  }

  const diff = execSync("git diff --cached").toString();
  if (!diff.trim()) {
    console.log("ℹ️  No hay cambios preparados (usa 'git add .' primero)");
    process.exit(0);
  }

  console.log("🧠 Analizando cambios...");

  if (args.list) {
    const options = await generateListCommits(diff);
    const choices = [
      ...options.map((opt, i) => ({
        name: `${opt.title}\n${opt.body ? opt.body + '\n' : ''}`,
        value: opt
      })),
      { name: REGENERATE_MSG, value: null }
    ];

    const { selected } = await inquirer.prompt({
      type: "list",
      name: "selected",
      message: "Elige un mensaje:",
      choices,
      pageSize: 10
    });

    if (!selected) return await runInteractive();
    return makeCommit(selected.title, selected.body);
  } else {
    const { title, body } = await generateCommit(diff);
    console.log(`\n💡 Mensaje generado:\n${title}\n${body ? '\n' + body + '\n' : ''}`);

    const { confirm } = await inquirer.prompt({
      type: "confirm",
      name: "confirm",
      message: "¿Crear commit con este mensaje?",
      default: true
    });

    if (confirm) makeCommit(title, body);
    else console.log("🚫 Operación cancelada");
  }
};

await runInteractive();


// 'use strict'
// import { execSync } from "child_process";
// import axios from "axios";
// import inquirer from "inquirer";
// import { writeFileSync, unlinkSync } from "fs";
// import { tmpdir } from "os";
// import path from "path";
// import { getArgs, checkGitRepository } from "./helpers.js";

// const args = getArgs();

// const REGENERATE_MSG = "♻️ Regenerar mensajes";
// const QWEN_MODEL = "qwen3:4b"; // O "qwen" si así lo tienes en Ollama local

// const makeCommit = (title, body = "") => {
//   console.log("Creando commit... 🚀");
//   const message = body ? `${title}\n\n${body}` : title;

//   // Crear archivo temporal para el mensaje
//   const tmpFilePath = path.join(tmpdir(), 'commit-msg.txt');
//   writeFileSync(tmpFilePath, message, 'utf8');

//   // Ejecutar git commit con archivo
//   execSync(`git commit --file="${tmpFilePath}"`, { stdio: 'inherit' });

//   // Borrar archivo temporal
//   unlinkSync(tmpFilePath);

//   console.log("✅ Commit creado exitosamente");
// };

// async function callQwenAPI(prompt) {
//   try {
//     const response = await axios.post(
//       "http://localhost:11434/api/chat",
//       {
//         model: QWEN_MODEL,
//         messages: [
//           {
//             role: "system",
//             content: "Eres un experto en mensajes de commit en español. Sigue estas reglas:\n" +
//               "1. Título conciso (máx 50 caracteres)\n" +
//               "2. Cuerpo explicativo obligatorio\n" +
//               "3. Usa formato: '<tipo>: <descripción>'\n" +
//               "4. Lenguaje claro y técnico con viñetas\n" +
//               "5. Nunca incluyas 'Resuelve #123' o referencias similares a issues"
//           },
//           {
//             role: "user",
//             content: prompt
//           }
//         ],
//         stream: false
//       }
//     );

//     return response.data.message.content;
//   } catch (error) {
//     console.error("❌ Error en la API de Ollama:", error.response?.data || error.message);
//     process.exit(1);
//   }
// }

// const generateCommit = async (diff) => {
//   const prompt =
//     `Genera un mensaje de commit profesional siguiendo ESTE FORMATO EXACTO:

// 1. TÍTULO (una línea, máximo 50 caracteres):
//    "<tipo>: <descripción breve en español>"

// 2. CUERPO (opcional pero recomendado):
//    * Lista con viñetas explicando los cambios
//    * En español claro, sin acentos
//    * Detalla qué, por qué (no cómo)

// --- REGLAS ESTRICTAS ---
// • TIPOS VÁLIDOS (usa SOLO estos):
//   - feat:     Nueva funcionalidad
//   - fix:      Corrección de errores
//   - docs:     Cambios en documentación
//   - style:    Formato/estructura (sin afectar código)
//   - refactor: Reestructuración de código existente
//   - perf:     Mejora de rendimiento
//   - test:     Añadir/mejorar pruebas
//   - chore:    Tareas de mantenimiento (config, dependencias)
//   - build:    Cambios en sistema de compilación
//   - ci:       Cambios en CI/CD
//   - revert:   Revertir un commit anterior

// • PROHIBIDO:
//   - Acentos o caracteres especiales
//   - Descripciones vagas ("arreglar cosas")
//   - Mencionar "código" (error común)
//   - Exceder 50 caracteres en el título

// --- EJEMPLO PERFECTO ---
// fix: Corregir error de validacion en formulario

// * El campo email no validaba dominios .com.co
// * Se añadió regex para validar formato correcto
// * Se mejoraron los mensajes de error

// --- CAMBIOS A DOCUMENTAR ---
// ${diff}

// Genera EXACTAMENTE 1 commit message siguiendo estas reglas.`;

//   let attempts = 0;
//   let title = "", body = "";

//   while (attempts < 3) {
//     const fullMessage = await callQwenAPI(prompt);
//     const [firstLine, ...rest] = fullMessage.split('\n').filter(Boolean);
//     title = firstLine.trim();
//     body = rest.join('\n').trim();

//     // Validación adicional para asegurar que el tipo está en inglés
//     const commitType = title.split(':')[0].trim();
//     const validTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci', 'revert'];

//     if (body.length > 0 && validTypes.includes(commitType)) {
//       return { title, body };
//     }

//     console.warn(`⚠️ Intento ${attempts + 1}: mensaje no cumple formato, reintentando...`);
//     attempts++;
//   }

//   console.error("❌ No se pudo generar un mensaje válido después de 3 intentos.");
//   process.exit(1);
// };

// const generateListCommits = async (diff, numOptions = 3) => {
//   const prompt =
//     `Genera ${numOptions} opciones de mensajes de commit para estos cambios:\n${diff}\n\n` +
//     "Formato para cada opción:\n" +
//     "TÍTULO|||CUERPO (detallado con viñetas, obligatorio)\n\n" +
//     "Ejemplo:\n" +
//     "docs: Añadir ejemplo de estructura avanzada|||* Incluye middleware: cors, helmet, express-rate-limit y morgan\n" +
//     "* Configura limitación de tasas (15min/100peticiones)\n" +
//     "* Agrega manejo de errores centralizado\n" +
//     "* Define ruta base /api para endpoints\n" +
//     "* Mejora seguridad y logging de la aplicación";

//   const response = await callQwenAPI(prompt);
//   return response.split('\n')
//     .filter(opt => opt.includes('|||'))
//     .map(opt => {
//       const [title, body] = opt.split('|||');
//       return {
//         title: title.trim(),
//         body: body?.trim() || ""
//       };
//     });
// };

// const runInteractive = async () => {
//   if (!checkGitRepository()) {
//     console.error("⚠️ No es un repositorio Git");
//     process.exit(1);
//   }

//   const diff = execSync("git diff --cached").toString();
//   if (!diff.trim()) {
//     console.log("ℹ️  No hay cambios preparados (usa 'git add .' primero)");
//     process.exit(0);
//   }

//   console.log("🧠 Analizando cambios...");

//   if (args.list) {
//     const options = await generateListCommits(diff);
//     const choices = [
//       ...options.map((opt) => ({
//         name: `${opt.title}\n${opt.body ? opt.body + '\n' : ''}`,
//         value: opt
//       })),
//       { name: REGENERATE_MSG, value: null }
//     ];

//     const { selected } = await inquirer.prompt({
//       type: "list",
//       name: "selected",
//       message: "Elige un mensaje:",
//       choices,
//       pageSize: 10
//     });

//     if (!selected) return await runInteractive();
//     return makeCommit(selected.title, selected.body);
//   } else {
//     const { title, body } = await generateCommit(diff);
//     console.log(`\n💡 Mensaje generado:\n${title}\n${body ? '\n' + body + '\n' : ''}`);

//     const { confirm } = await inquirer.prompt({
//       type: "confirm",
//       name: "confirm",
//       message: "¿Crear commit con este mensaje?",
//       default: true
//     });

//     if (confirm) makeCommit(title, body);
//     else console.log("🚫 Operación cancelada");
//   }
// };

// await runInteractive();