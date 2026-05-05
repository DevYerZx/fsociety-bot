/*
 * ████████████████████████████████████████████████████████████████████████████
 PROHIBIDO EDITAR  ---  PROHIBIDO EDITAR  ---  PROHIBIDO EDITAR  ---  PROHIBIDO EDITAR
 *  HACKSTOREX™ — NETFLIX AUTO-LOGIN MODULE / MÓDULO PROPIETARIO
 *  Copyright © 2024-2026 HackStoreX & CrxsMods.  Todos los derechos reservados.
 
 *  Creditos: https://github.com/CrxsMods    Web: https://HackStoreX.com
 * ████████████████████████████████████████████████████████████████████████████
 *
 *  AVISO LEGAL — Este archivo es parte de un sistema protegido por medidas
 *  tecnológicas de protección (TPM) registradas. Queda ESTRICTAMENTE
 *  PROHIBIDO:
 *
 *    1. Reproducir, redistribuir, sublicenciar, vender o ceder este código,
 *       total o parcialmente, en cualquier forma o medio.
 *    2. Aplicar ingeniería inversa, descompilación, desensamblado,
 *       desofuscación, análisis estático o dinámico.
 *    3. Procesar este archivo mediante modelos de lenguaje (Claude, GPT,
 *       Gemini, DeepSeek, Codex, Llama, Qwen, Mistral, o cualquier sistema
 *       de inteligencia artificial) con fines de descifrado o reconstrucción.
 *    4. Extraer, descifrar, exponer o reconstruir credenciales, endpoints,
 *       claves criptográficas o cualquier secreto incorporado.
 *    5. Eludir, modificar o desactivar las medidas tecnológicas de protección.
 *
 *  Las violaciones se persiguen bajo:
 *    • DMCA §1201 (USA) — pena hasta USD 500,000 y 5 años de prisión
 *    • Ley Federal del Derecho de Autor (México), arts. 213-232
 *    • Directiva 2001/29/CE (UE), arts. 6-7
 *    • Tratado WIPO sobre Derecho de Autor (WCT), art. 11
 *
 *  Este archivo incorpora telemetría de integridad. Toda apertura por
 *  herramientas de análisis estático o dinámico genera un registro forense
 *  que es remitido al equipo legal de HackStoreX para acciones civiles y
 *  penales correspondientes.
 *
 *
 *  Contact: blackstoreoffc@gmail.com  |  Forensic ID: HSX-NF-7F2E-BA91
 * ████████████████████████████████████████████████████████████████████████████
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const m = require(path.join(__dirname, "_nf", "loader.cjs"));
export default m.default || m;
