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

// Configuración de tokens
const MAX_TOKEN_LENGTH = 13050; // Límite aproximado de tokens por solicitud
const CHUNK_OVERLAP = 200; // Solapamiento entre chunks para mantener contexto

// Función para estimar tokens (aproximación simple)
function estimateTokens(text) {
  // Aproximación: 1 token ≈ 4 caracteres para texto en español
  return Math.ceil(text.length / 4);
}

// Función para validar que el mensaje esté en español
function validateSpanishCommit(title, body) {
  // Palabras clave en inglés que NO deben aparecer en commits
  const englishKeywords = [
    'add', 'added', 'adding', 'create', 'created', 'creating', 'update', 'updated', 'updating',
    'fix', 'fixed', 'fixing', 'remove', 'removed', 'removing', 'delete', 'deleted', 'deleting',
    'implement', 'implemented', 'implementing', 'improve', 'improved', 'improving',
    'refactor', 'refactored', 'refactoring', 'change', 'changed', 'changing',
    'modify', 'modified', 'modifying', 'enhance', 'enhanced', 'enhancing'
  ];

  // Palabras clave en español que SÍ deben aparecer
  const spanishKeywords = [
    'agregar', 'añadir', 'crear', 'actualizar', 'corregir', 'solucionar', 'arreglar',
    'eliminar', 'remover', 'implementar', 'mejorar', 'refactorizar', 'cambiar',
    'modificar', 'optimizar', 'configurar', 'integrar', 'desarrollar'
  ];

  const fullText = (title + ' ' + body).toLowerCase();
  
  // Verificar si contiene palabras en inglés
  const hasEnglish = englishKeywords.some(keyword => 
    fullText.includes(keyword.toLowerCase())
  );
  
  // Verificar si contiene palabras en español
  const hasSpanish = spanishKeywords.some(keyword => 
    fullText.includes(keyword.toLowerCase())
  );

  // Verificar que el título no esté en inglés
  const titleLower = title.toLowerCase();
  const isEnglishTitle = englishKeywords.some(keyword => 
    titleLower.includes(keyword)
  );

  return {
    isValid: !hasEnglish && !isEnglishTitle,
    hasSpanish,
    hasEnglish,
    isEnglishTitle
  };
}

// Función para dividir el diff en chunks manejables
function splitDiffIntoChunks(diff, maxTokens = MAX_TOKEN_LENGTH) {
  const lines = diff.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);
    
    // Si una sola línea excede el límite, la dividimos
    if (lineTokens > maxTokens) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [];
        currentTokens = 0;
      }
      
      // Dividir línea muy larga
      const longLineChunks = splitLongLine(line, maxTokens);
      chunks.push(...longLineChunks);
      continue;
    }
    
    // Si agregar esta línea excede el límite, guardamos el chunk actual
    if (currentTokens + lineTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
      
      // Mantener solapamiento para contexto
      const overlapLines = Math.min(5, currentChunk.length);
      currentChunk = currentChunk.slice(-overlapLines);
      currentTokens = estimateTokens(currentChunk.join('\n'));
    }
    
    currentChunk.push(line);
    currentTokens += lineTokens;
  }
  
  // Agregar el último chunk si no está vacío
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }
  
  return chunks;
}

// Función para dividir líneas muy largas
function splitLongLine(line, maxTokens) {
  const chunks = [];
  const maxLength = maxTokens * 4; // Convertir tokens a caracteres aproximados
  
  for (let i = 0; i < line.length; i += maxLength) {
    chunks.push(line.substring(i, i + maxLength));
  }
  
  return chunks;
}

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
              "Eres un experto en mensajes de commit en ESPAÑOL ÚNICAMENTE. REGLAS ABSOLUTAS:\n" +
              "1. TODOS los mensajes deben estar en español, NUNCA en inglés\n" +
              "2. Título conciso (máx 50 caracteres) SIN acentos\n" +
              "3. Cuerpo explicativo OBLIGATORIO en español\n" +
              "4. Usa formato: '<tipo>: <descripción EN ESPAÑOL>'\n" +
              "5. Lenguaje claro y técnico con viñetas EN ESPAÑOL\n" +
              "6. Nunca incluyas 'Resuelve #123' o referencias similares a issues\n" +
              "7. PROHÍBIDO usar palabras en inglés como 'add', 'fix', 'update', 'create', etc.\n" +
              "8. Usa verbos en infinitivo en español: 'agregar', 'corregir', 'actualizar', 'crear'\n" +
              "9. Si detectas inglés en tu respuesta, CORRIGE inmediatamente al español\n" +
              "10. VALIDACIÓN: Cada mensaje debe sonar natural en español latino"
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
        timeout: 30000
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error("Error en la API:", error.response?.data || error.message);
    process.exit(1);
  }
}

// Función para analizar chunks individualmente
async function analyzeChunk(chunk, chunkIndex, totalChunks) {
  const prompt = `Analiza este fragmento de cambios Git (parte ${chunkIndex + 1} de ${totalChunks}) y responde ÚNICAMENTE EN ESPAÑOL:

--- CONTEXTO ---
Este es un fragmento de un diff más grande. Analiza SOLO este fragmento y describe EN ESPAÑOL:
1. Tipo de cambios principales (feat, fix, docs, style, refactor, etc.)
2. Componentes/archivos afectados
3. Cambios específicos realizados
4. Patrones o temas recurrentes

--- FRAGMENTO A ANALIZAR ---
${chunk}

--- FORMATO DE RESPUESTA EN ESPAÑOL ---
Responde en este formato JSON (TODO EN ESPAÑOL):
{
  "tipo_principal": "feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert",
  "componentes": ["componente1", "componente2"],
  "cambios": [
    "Cambio específico 1 EN ESPAÑOL",
    "Cambio específico 2 EN ESPAÑOL"
  ],
  "contexto": "Breve descripción del propósito general EN ESPAÑOL"
}

IMPORTANTE: Toda la respuesta debe estar en español. No uses palabras en inglés.`;

  const response = await callQwenAPI(prompt);
  
  try {
    // Intentar parsear como JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // Si no es JSON válido, crear estructura manual
    console.warn(`⚠️ Respuesta no es JSON válido para chunk ${chunkIndex + 1}, procesando manualmente...`);
  }
  
  // Análisis manual si el JSON falla
  return {
    tipo_principal: "chore",
    componentes: ["codigo"],
    cambios: [`Cambios en fragmento ${chunkIndex + 1}`],
    contexto: response.substring(0, 100) + "..."
  };
}

// Función para consolidar análisis de múltiples chunks
function consolidateAnalysis(analyses) {
  const tiposFrecuencia = {};
  const todosComponentes = [];
  const todosCambios = [];
  const contextos = [];

  analyses.forEach(analysis => {
    // Contar tipos
    const tipo = analysis.tipo_principal;
    tiposFrecuencia[tipo] = (tiposFrecuencia[tipo] || 0) + 1;
    
    // Recopilar componentes
    if (analysis.componentes) {
      todosComponentes.push(...analysis.componentes);
    }
    
    // Recopilar cambios
    if (analysis.cambios) {
      todosCambios.push(...analysis.cambios);
    }
    
    // Recopilar contexto
    if (analysis.contexto) {
      contextos.push(analysis.contexto);
    }
  });

  // Determinar tipo principal (más frecuente)
  const tipoPrincipal = Object.entries(tiposFrecuencia)
    .sort(([,a], [,b]) => b - a)[0][0];

  // Eliminar duplicados de componentes
  const componentesUnicos = [...new Set(todosComponentes)];

  return {
    tipo_principal: tipoPrincipal,
    componentes: componentesUnicos,
    cambios: todosCambios,
    contexto_general: contextos.join('. ')
  };
}

const generateCommit = async (diff) => {
  const diffTokens = estimateTokens(diff);
  
  console.log(`📊 Tokens estimados: ${diffTokens}`);
  
  if (diffTokens <= MAX_TOKEN_LENGTH) {
    console.log("✅ Diff cabe en una sola solicitud");
    return await generateSingleCommit(diff);
  }
  
  console.log("🔄 Diff muy largo, dividiendo en chunks...");
  const chunks = splitDiffIntoChunks(diff);
  console.log(`📦 Dividido en ${chunks.length} chunks`);
  
  // Analizar cada chunk
  const analyses = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`🔍 Analizando chunk ${i + 1}/${chunks.length}...`);
    const analysis = await analyzeChunk(chunks[i], i, chunks.length);
    analyses.push(analysis);
    
    // Pausa entre solicitudes para evitar rate limiting
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Consolidar análisis
  console.log("🔄 Consolidando análisis...");
  const consolidatedAnalysis = consolidateAnalysis(analyses);
  
  // Generar commit final basado en análisis consolidado
  return await generateCommitFromAnalysis(consolidatedAnalysis);
};

// Función para generar commit de un diff simple
async function generateSingleCommit(diff) {
  const prompt = `Genera EXACTAMENTE 1 mensaje de commit profesional ÚNICAMENTE EN ESPAÑOL con estas REGLAS ABSOLUTAS:

--- FORMATO EXACTO (TODO EN ESPAÑOL) ---
<tipo>: <título en español (max 50 chars, sin acentos)>
* <viñeta 1 en infinitivo español - cambio principal OBLIGATORIO>
* <viñeta 2 en español - cambio secundario RELEVANTE si aplica>
* <viñeta N en español - detalles técnicos adicionales NECESARIOS>

--- TIPOS PERMITIDOS (SOLO ESTOS) ---
feat    - Nueva funcionalidad
fix     - Corrección de errores
docs    - Documentación
style   - Formato/estructura
refactor- Reestructuración sin cambiar funcionalidad
perf    - Mejora de rendimiento
test    - Pruebas
chore   - Mantenimiento
build   - Sistema de compilación
ci      - Integración continua
revert  - Revertir cambios

--- REGLAS DE IDIOMA ESPAÑOL ---
• PROHÍBIDO usar palabras en inglés como: add, fix, update, create, remove, etc.
• USA SOLO verbos en español: agregar, corregir, actualizar, crear, eliminar, etc.
• Toda descripción debe estar en español natural
• Sin acentos en el título para compatibilidad
• Cuerpo con viñetas detalladas en español

--- CAMBIOS A DOCUMENTAR ---
${diff}

Genera EXACTAMENTE 1 commit message EN ESPAÑOL siguiendo estas reglas.`;

  let attempts = 0;
  let title = "", body = "";

  while (attempts < 5) {
    const fullMessage = await callQwenAPI(prompt);
    const [firstLine, ...rest] = fullMessage.split('\n').filter(Boolean);
    title = firstLine.trim();
    body = rest.join('\n').trim();

    const commitType = title.split(':')[0].trim();
    const validTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci', 'revert'];
    
    // Validar que esté en español
    const spanishValidation = validateSpanishCommit(title, body);
    
    if (body.length > 0 && validTypes.includes(commitType) && spanishValidation.isValid) {
      console.log("✅ Commit generado en español correctamente");
      return { title, body };
    }

    if (!spanishValidation.isValid) {
      console.warn(`⚠️ Intento ${attempts + 1}: mensaje contiene inglés, regenerando en español...`);
      if (spanishValidation.hasEnglish) {
        console.warn("   - Detectadas palabras en inglés");
      }
      if (spanishValidation.isEnglishTitle) {
        console.warn("   - Título en inglés detectado");
      }
    } else {
      console.warn(`⚠️ Intento ${attempts + 1}: mensaje no cumple formato, reintentando...`);
    }
    
    attempts++;
  }

  console.error("❌ No se pudo generar un mensaje válido en español después de 5 intentos.");
  process.exit(1);
}

// Función para generar commit basado en análisis consolidado
async function generateCommitFromAnalysis(analysis) {
  const prompt = `Genera un mensaje de commit profesional ÚNICAMENTE EN ESPAÑOL basado en este análisis consolidado:

--- ANÁLISIS CONSOLIDADO ---
Tipo principal: ${analysis.tipo_principal}
Componentes afectados: ${analysis.componentes.join(', ')}
Cambios realizados:
${analysis.cambios.map(c => `- ${c}`).join('\n')}

Contexto general: ${analysis.contexto_general}

--- FORMATO REQUERIDO (TODO EN ESPAÑOL) ---
<tipo>: <título en español (max 50 chars, sin acentos)>
* <viñeta 1 en español - cambio principal más importante>
* <viñeta 2 en español - cambio secundario relevante>
* <viñeta N en español - detalles técnicos adicionales>

--- REGLAS ESTRICTAS DE IDIOMA ---
1. Usa el tipo principal identificado: ${analysis.tipo_principal}
2. Título conciso que resuma el cambio general EN ESPAÑOL
3. Viñetas que expliquen los cambios más importantes EN ESPAÑOL
4. Máximo 50 caracteres en el título
5. Español sin acentos
6. PROHÍBIDO usar palabras en inglés
7. Usa verbos en infinitivo español: agregar, corregir, actualizar, crear, eliminar

Genera el mensaje de commit EN ESPAÑOL:`;

  let attempts = 0;
  let title = "", body = "";

  while (attempts < 5) {
    const fullMessage = await callQwenAPI(prompt);
    const [firstLine, ...rest] = fullMessage.split('\n').filter(Boolean);
    title = firstLine.trim();
    body = rest.join('\n').trim();

    const commitType = title.split(':')[0].trim();
    const validTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci', 'revert'];
    
    // Validar que esté en español
    const spanishValidation = validateSpanishCommit(title, body);

    if (body.length > 0 && validTypes.includes(commitType) && spanishValidation.isValid) {
      console.log("✅ Commit generado en español correctamente");
      return { title, body };
    }

    if (!spanishValidation.isValid) {
      console.warn(`⚠️ Intento ${attempts + 1}: mensaje contiene inglés, regenerando en español...`);
    } else {
      console.warn(`⚠️ Intento ${attempts + 1}: mensaje no cumple formato, reintentando...`);
    }
    
    attempts++;
  }

  console.error("❌ No se pudo generar un mensaje válido en español después de 5 intentos.");
  process.exit(1);
}

const generateListCommits = async (diff, numOptions = "3") => {
  const diffTokens = estimateTokens(diff);
  
  if (diffTokens > MAX_TOKEN_LENGTH) {
    console.log("⚠️ Diff muy largo para generar múltiples opciones, usando análisis por chunks...");
    const chunks = splitDiffIntoChunks(diff);
    
    // Para opciones múltiples con diff largo, generar análisis simplificado
    const analyses = [];
    for (let i = 0; i < Math.min(chunks.length, 3); i++) {
      const analysis = await analyzeChunk(chunks[i], i, chunks.length);
      analyses.push(analysis);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const consolidatedAnalysis = consolidateAnalysis(analyses);
    
    // Generar opciones basadas en análisis consolidado
    const options = [];
    for (let i = 0; i < parseInt(numOptions); i++) {
      const commit = await generateCommitFromAnalysis(consolidatedAnalysis);
      options.push(commit);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return options;
  }

  // Diff normal, usar método original
  const prompt = `Genera EXACTAMENTE ${numOptions} opciones de mensajes de commit SEMÁNTICOS ÚNICAMENTE EN ESPAÑOL para estos cambios:

--- CAMBIOS A COMMITIR ---
${diff}

--- FORMATO REQUERIDO (TODO EN ESPAÑOL) ---
Para cada opción, usa el formato:
<tipo>: <título EN ESPAÑOL>|||<cuerpo con viñetas EN ESPAÑOL>

Ejemplo correcto:
feat: Implementar autenticacion biometrica|||* Añadir soporte para huella digital
* Integrar API de FaceID
* Crear tests de seguridad

--- REGLAS ESTRICTAS DE IDIOMA ---
• PROHÍBIDO usar palabras en inglés como: add, fix, update, create, remove, etc.
• USA SOLO verbos en español: agregar, corregir, actualizar, crear, eliminar, etc.
• Toda descripción debe estar en español natural
• Sin acentos en el título para compatibilidad
• Cuerpo con viñetas detalladas en español

Genera ${numOptions} opciones diferentes EN ESPAÑOL:`;

  let attempts = 0;
  let validOptions = [];

  while (attempts < 3 && validOptions.length < parseInt(numOptions)) {
    const response = await callQwenAPI(prompt);
    const options = response.split('\n')
      .filter(opt => opt.includes('|||'))
      .map(opt => {
        const [title, body] = opt.split('|||');
        return {
          title: title.trim(),
          body: body?.trim() || ""
        };
      });

    // Validar que todas las opciones estén en español
    for (const option of options) {
      const spanishValidation = validateSpanishCommit(option.title, option.body);
      if (spanishValidation.isValid && validOptions.length < parseInt(numOptions)) {
        validOptions.push(option);
      }
    }

    attempts++;
  }

  if (validOptions.length === 0) {
    console.error("❌ No se pudieron generar opciones válidas en español");
    process.exit(1);
  }

  console.log(`✅ Generadas ${validOptions.length} opciones en español`);
  return validOptions;
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