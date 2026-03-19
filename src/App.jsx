import { useState, useRef } from "react";
import * as mammoth from "mammoth";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function loadFileContent(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".docx") || file.type === DOCX_MIME) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value || "";
  }
  return file.text();
}

/* ═══════════════════════════════════════════════════════════
   INTELLIGENT DOCUMENT PARSER
   Handles: EDI specs, ER listings, integration docs,
   requirements docs, Avalara/tax specs, form-based flows
   ═══════════════════════════════════════════════════════════ */

function translateDocument(rawText) {
  if (!rawText.trim()) return null;
  const text = rawText.trim();
  const lines = text.split(/\r?\n/);
  const docType = detectDocType(text);
  const refs = extractJDERefs(text);
  const sections = extractSections(lines);
  const mappings = extractMappings(text);
  const exceptions = extractExceptions(text, sections);
  const processSteps = extractProcessSteps(text, sections);
  return buildOrchestration(docType, refs, sections, mappings, exceptions, processSteps, text);
}

function detectDocType(text) {
  if (/listing of er for application/i.test(text)) return "er";
  if (/\b(810|invoice)\b.*\b(canonical|edi|outbound)\b/i.test(text)) return "edi-outbound";
  if (/\b(850|purchase\s*order)\b.*\b(canonical|edi|inbound)\b/i.test(text)) return "edi-inbound";
  if (/\b(855|order\s*ack)/i.test(text) && /canonical|edi/i.test(text)) return "edi-outbound";
  if (/\b(856|shipment\s*notice|asn)\b.*\b(canonical|edi)/i.test(text)) return "edi-outbound";
  if (/\bedi\b.*\bcanonical/i.test(text)) return /inbound/i.test(text) ? "edi-inbound" : "edi-outbound";
  if (/\bavalara\b/i.test(text) || /\btax\s*(cal|interface|integration)\b/i.test(text)) return "tax-integration";
  if (/\brest\s*api\b/i.test(text) && /\borchestration\b/i.test(text)) return "api-integration";
  if (/\bquick\s*hire\b/i.test(text)) return "form-integration";
  if (/\bbenefit\s*enroll/i.test(text)) return "form-integration";
  if (/\bfreight\b.*\bmanagement\b/i.test(text) || /\bTFM\b/.test(text)) return "api-integration";
  if (/\borchestration\b/i.test(text) && /\bftp\b/i.test(text)) return "file-integration";
  if (/\bpo\s*requisition\b/i.test(text) || /\bpurchase\s*order\b/i.test(text)) return "form-integration";
  if (/\brequirements?\s*:/i.test(text) || /^\d+\.\s/m.test(text)) return "requirements";
  return "general";
}

function extractJDERefs(text) {
  const tables = [...new Set((text.match(/\bF\d{4,5}[A-Z]?\b/g) || []))].sort();
  const apps = [...new Set((text.match(/\bP\d{4,6}[A-Z]?\b/g) || []))].sort();
  const ubes = [...new Set((text.match(/\bR\d{4,7}[A-Z_0-9]*\b/g) || []))].sort();
  const bsfns = [...new Set((text.match(/\bB\d{4,6}[A-Z0-9]*\b/g) || []))].sort();
  const aliasPattern = /\b(DOCO|AN8|SHAN|VR01|TRDJ|EDOC|SHPN|EDBT|EDBATCH|DOC|LNID|ALPH|MCU|ITM|LITM|AITM|UORG|UPRC|APTS|STAM|EDSP|DEL1|CTY1|ADDS|ADDZ|COUN|ADD1|OORN|EDLN|EDCT|EDFT|EDDT|KCOO|EDSQ)\b/g;
  const aliases = [...new Set((text.match(aliasPattern) || []))].sort();
  const udcs = [...new Set((text.match(/\b\d{2}\/[A-Z]{2}\b/g) || []))];
  return { tables, apps, ubes, bsfns, aliases, udcs };
}

function extractSections(lines) {
  const sections = {};
  let currentHeading = null;
  let currentContent = [];
  const headingPatterns = [
    /^#{1,3}\s+(.+)/,
    /^(Source|Exceptions?\s*(?:or\s*Filters?)?|Sample\s*Document|Current\s*Process|Mapping|Calculations?|Requirements?|General\s*Considerations?)\s*:?\s*$/i,
  ];
  for (const line of lines) {
    let isHeading = false;
    for (const pattern of headingPatterns) {
      const m = line.trim().match(pattern);
      if (m) {
        if (currentHeading) sections[currentHeading] = currentContent.join("\n").trim();
        currentHeading = (m[1] || line.trim()).replace(/^#+\s*/, "").trim();
        currentContent = [];
        isHeading = true;
        break;
      }
    }
    if (!isHeading && currentHeading) currentContent.push(line);
  }
  if (currentHeading) sections[currentHeading] = currentContent.join("\n").trim();
  return sections;
}

function extractMappings(text) {
  const mappings = [];
  const mapRegex = /\b(HDR|DTL|SON|ADD|ITM|TTL|TRM)(\d{1,2})\s*[–\-\s\t]+(.+?)(?=\n|$)/gi;
  let m;
  while ((m = mapRegex.exec(text)) !== null) {
    const desc = m[3].replace(/\t+/g, " ").trim();
    if (desc.length > 0) mappings.push({ segment: m[1].toUpperCase(), field: `${m[1].toUpperCase()}${m[2].padStart(2, "0")}`, description: desc.substring(0, 120) });
  }
  return mappings;
}

function extractExceptions(text, sections) {
  const exceptions = [];
  const excSection = Object.entries(sections).find(([k]) => /exception|filter/i.test(k));
  if (excSection) {
    for (const line of excSection[1].split("\n").filter((l) => l.trim())) {
      const cleaned = line.replace(/^[\s\u00b7\u2022\-*]+/, "").trim();
      if (cleaned.length > 10 && cleaned.length < 300) exceptions.push(cleaned);
    }
  }
  const ifMatches = text.match(/\bIf\s+(?:an?\s+)?[^.]{10,100}/gi) || [];
  for (const match of ifMatches) {
    if (!exceptions.some((e) => e.includes(match.trim().substring(0, 30)))) exceptions.push(match.trim());
  }
  return exceptions.slice(0, 10);
}

function extractProcessSteps(text, sections) {
  const steps = [];
  const procSection = Object.entries(sections).find(([k]) => /current\s*process/i.test(k));
  if (procSection) {
    for (const line of procSection[1].split("\n").filter((l) => l.trim())) {
      const cleaned = line.replace(/^[\s\u00b7\u2022\-*]+/, "").trim();
      if (cleaned.length > 5) steps.push(cleaned);
    }
  }
  if (steps.length === 0) {
    for (const line of (text.match(/^\s*\d+\.\s+.{10,}/gm) || [])) steps.push(line.replace(/^\s*\d+\.\s+/, "").trim());
  }
  if (steps.length === 0) {
    // Match bullet lines: -, *, ·, •, or roman numeral style (i., ii., iii.)
    const bulletRegex = /^[\s]*(?:[\u00b7\u2022\-*]|\b[ivx]+\.)\s+.{15,}/gm;
    for (const b of (text.match(bulletRegex) || []).slice(0, 15)) {
      const cleaned = b.replace(/^[\s\u00b7\u2022\-*]+/, "").replace(/^[ivx]+\.\s*/, "").trim();
      // Skip JSON-like lines and very short items
      if (cleaned.length > 10 && !cleaned.startsWith("{") && !cleaned.startsWith('"') && !/^\d+$/.test(cleaned)) {
        steps.push(cleaned);
      }
    }
  }
  return steps.slice(0, 20);
}

function deriveOrchName(text, docType) {
  const firstLines = text.split(/\r?\n/).filter((l) => l.trim().length > 5);
  const title = firstLines[0]?.trim() || "";
  if (docType === "edi-outbound") {
    const ediMatch = text.match(/\b(810|855|856)\b/);
    const names = { "810": "Invoice", "855": "Order Acknowledgment", "856": "Advanced Shipment Notice" };
    if (ediMatch) return `EDI ${ediMatch[1]} ${names[ediMatch[1]] || ""} Outbound Generation`;
  }
  if (docType === "edi-inbound") {
    if (/\b850\b/.test(text)) return "EDI 850 Purchase Order Inbound Processing";
    return "EDI Inbound Processing";
  }
  if (docType === "tax-integration") return "Avalara Tax Integration Orchestration";
  if (docType === "api-integration" && /TFM|freight/i.test(text)) return "Target Freight Management API Integration";
  // Detect specific JDE processes mentioned in the doc
  if (/po\s*requisition/i.test(text)) return "PO Requisition Creation via REST API";
  if (/quick\s*hire/i.test(text)) return "Quick Hire Employee Integration";
  if (/benefit\s*enroll/i.test(text)) return "Benefit Enrollment Processing";
  if (/sales\s*order/i.test(text)) return "Sales Order Entry Integration";
  if (/purchase\s*order/i.test(text) && /creat|entry|process/i.test(text)) return "Purchase Order Creation Integration";
  if (/invoice/i.test(text) && /creat|process|generat/i.test(text)) return "Invoice Processing Orchestration";
  if (title.length > 5 && title.length < 120) return title.replace(/canonical\s*file\s*specifications?\s*/i, "Orchestration").replace(/\s*:?\s*$/, "");
  return "JDE Integration Orchestration";
}

function buildOrchestration(docType, refs, sections, mappings, exceptions, processSteps, text) {
  const orchName = deriveOrchName(text, docType);
  const inputs = buildInputs(docType, refs, mappings, text);
  const variables = buildVariables(docType, refs, mappings, text);
  const steps = buildSteps(docType, refs, sections, mappings, exceptions, processSteps, text);
  const outputs = buildOutputs(docType, refs, mappings, text);
  return { orchName, inputs, variables, steps, outputs };
}

function buildInputs(docType, refs, mappings, text) {
  const inputs = [];
  if (docType === "edi-inbound") {
    inputs.push("Canonical flat file from VAN (EDI X12 or XML)");
    const segments = [...new Set(mappings.map((m) => m.segment))];
    if (segments.length > 0) inputs.push(`File segments: ${segments.join(", ")}`);
    inputs.push("Partner ID / Customer identifier");
    if (refs.aliases.includes("VR01")) inputs.push("Purchase Order Number (VR01)");
  } else if (docType === "edi-outbound") {
    if (refs.tables.length > 0) inputs.push(`Source tables: ${refs.tables.slice(0, 4).join(", ")}`);
    inputs.push("Invoice/Order records not yet sent (EDSP <> 'Y')");
    if (refs.aliases.includes("AN8")) inputs.push("Customer Address Number (AN8)");
    if (refs.aliases.includes("EDOC")) inputs.push("EDI Document Number (EDOC)");
  } else if (docType === "er") {
    const vaLines = text.match(/VA\s+\S+\s*=\s*.+/gi) || [];
    for (const va of vaLines.slice(0, 6)) {
      const m = va.match(/VA\s+(\S+)\s*=\s*(.+)/i);
      if (m) inputs.push(m[1].replace(/^frm_|_OBJP|_PID|_BASIST|_EV\d+$/gi, "").replace(/_/g, " "));
    }
    if (inputs.length === 0) inputs.push("Business Unit", "Form ID", "Application ID");
  } else if (docType === "api-integration") {
    if (/rest\s*api/i.test(text)) inputs.push("REST API endpoint / payload");
    if (/ftp/i.test(text)) inputs.push("FTP file location");
    // Extract JSON field names from payload examples
    const jsonFields = text.match(/"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g) || [];
    const fieldNames = [...new Set(jsonFields.map((f) => f.replace(/["':]/g, "").trim()))];
    if (fieldNames.length > 0) {
      // Group top-level vs nested (simple heuristic: if inside "lines" array context)
      const topLevel = fieldNames.filter((f) => !["item", "quantity", "price", "uom", "description", "lineNumber"].includes(f));
      const lineLevel = fieldNames.filter((f) => ["item", "quantity", "price", "uom", "description", "lineNumber"].includes(f));
      if (topLevel.length > 0) inputs.push(`Header fields: ${topLevel.join(", ")}`);
      if (lineLevel.length > 0) inputs.push(`Line item fields: ${lineLevel.join(", ")}`);
    }
    if (refs.apps.length > 0) inputs.push(`JDE Applications: ${refs.apps.join(", ")}`);
    if (inputs.length < 2) inputs.push("Request parameters / key fields");
  } else if (docType === "tax-integration") {
    inputs.push("Tax calculation request (address, amounts, tax codes)");
    if (refs.apps.length > 0) inputs.push(`Calling applications: ${refs.apps.join(", ")}`);
    inputs.push("Ship-to address / GeoCode");
  } else if (docType === "form-integration") {
    if (refs.apps.length > 0) inputs.push(`Application: ${refs.apps.join(", ")}`);
    if (/quick\s*hire/i.test(text)) inputs.push("Employee data (name, address, SSN, hire date)");
    if (/benefit/i.test(text)) inputs.push("Benefit enrollment selections");
    if (/po\s*requisition|purchase\s*order/i.test(text)) inputs.push("PO header and line item data");
    inputs.push("Business Unit");
  } else {
    if (refs.apps.length > 0) inputs.push(`Applications: ${refs.apps.join(", ")}`);
    if (refs.tables.length > 0) inputs.push(`Tables: ${refs.tables.slice(0, 5).join(", ")}`);
    inputs.push("Key business parameters");
  }
  return inputs.filter(Boolean);
}

function buildVariables(docType, refs, mappings, text) {
  const vars = [];
  const ad = { DOCO: "DOCO = Sales Order Number", AN8: "AN8 = Address Number", SHAN: "SHAN = Ship To Address", VR01: "VR01 = Customer PO Number", TRDJ: "TRDJ = Transaction Date", EDOC: "EDOC = EDI Document Number", SHPN: "SHPN = Shipment Number", EDBT: "EDBT = EDI Batch Number", DOC: "DOC = Document Number", LNID: "LNID = Line Number", ALPH: "ALPH = Alpha Name", MCU: "MCU = Business Unit", ITM: "ITM = Item Number (short)", LITM: "LITM = Item Number (2nd)", UORG: "UORG = Quantity Ordered", UPRC: "UPRC = Unit Price", STAM: "STAM = Status", EDSP: "EDSP = EDI Processed Flag", OORN: "OORN = Original Order Number" };
  for (const alias of refs.aliases) { if (ad[alias]) vars.push(ad[alias]); }
  if (docType === "er") {
    for (const va of (text.match(/VA\s+\S+\s*=\s*.+/gi) || []).slice(0, 8)) {
      const m = va.match(/VA\s+(\S+)\s*=\s*(.+)/i);
      if (m) { const val = m[2].replace(/^["']|["']$/g, "").trim(); vars.push(val.length < 30 ? `${m[1]} = ${val}` : m[1]); }
    }
  }
  if (mappings.length > 0 && vars.length < 8) {
    const sg = {};
    for (const m of mappings) { sg[m.segment] = (sg[m.segment] || 0) + 1; }
    for (const [seg, count] of Object.entries(sg)) vars.push(`${seg} segment fields (${count} mapped)`);
  }
  // Extract JSON payload field names as variables
  if (vars.length < 6) {
    const jsonFields = text.match(/"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g) || [];
    const fieldNames = [...new Set(jsonFields.map((f) => f.replace(/["':]/g, "").trim()))];
    for (const fn of fieldNames.slice(0, 10)) vars.push(`${fn} = Input payload field`);
  }
  if (!vars.some((v) => /status|error/i.test(v))) { vars.push("cStatus = Processing Status"); vars.push("cErrorCode = Error indicator"); }
  return vars.filter(Boolean).slice(0, 20);
}

function buildSteps(docType, refs, sections, mappings, exceptions, processSteps, text) {
  const steps = [];
  let n = 1;

  if (docType === "edi-outbound") {
    steps.push({ number: String(n++), name: "Initialize Variables", type: "Variable Assignment", description: "Set processing variables: batch number, status flags, date range." });
    steps.push({ number: String(n++), name: "Retrieve Unprocessed Records", type: "Data Request", service: refs.tables[0] || "F47047", description: `Query ${refs.tables.slice(0, 3).join(", ") || "EDI tables"} for records not yet sent (EDSP <> 'Y').` });
    if (refs.tables.length > 1) steps.push({ number: String(n++), name: "Retrieve Customer/Detail Data", type: "Data Request", service: refs.tables.slice(1, 4).join(", "), description: `Fetch customer info, line details, addresses from ${refs.tables.slice(1, 4).join(", ")}.` });
    if (exceptions.length > 0) steps.push({ number: String(n++), name: "Validate Exceptions and Filters", type: "Rules", logic: exceptions.slice(0, 3).map((e) => e.length > 80 ? e.substring(0, 77) + "..." : e).join("\n"), description: "Apply exception rules. Skip and report records that fail validation." });
    if (mappings.length > 0) { const segs = [...new Set(mappings.map((m) => m.segment))]; steps.push({ number: String(n++), name: "Map Fields to Canonical Format", type: "Service Request", service: "Field Transformation", description: `Transform JDE fields to canonical segments: ${segs.join(", ")}. ${mappings.length} fields mapped.` }); }
    for (const ps of processSteps.slice(0, 5)) {
      if (ps.length > 10 && !steps.some((s) => s.description?.includes(ps.substring(0, 20)))) {
        steps.push({ number: String(n++), name: ps.length > 50 ? ps.substring(0, 47) + "..." : ps, type: /check|valid/i.test(ps) ? "Rules" : /report|skip/i.test(ps) ? "Condition" : /build|generat|creat/i.test(ps) ? "Service Request" : /email|notif/i.test(ps) ? "Notification" : "Service Request", description: ps });
      }
    }
    steps.push({ number: String(n++), name: "Generate Canonical Output File", type: "File Operation", description: "Write formatted canonical file with all segments." });
    steps.push({ number: String(n++), name: "Send File via FTP", type: "Connector", service: "FTP / VAN", description: "Transmit canonical file to trading partner." });
    steps.push({ number: String(n++), name: "Update Processing Status", type: "Data Request", service: refs.tables[0] || "F47047", description: "Mark processed records as sent (EDSP = 'Y')." });
    if (/email|notif/i.test(text)) steps.push({ number: String(n++), name: "Send Notification", type: "Notification", description: "Email notification with processing results and exceptions." });

  } else if (docType === "edi-inbound") {
    steps.push({ number: String(n++), name: "Receive Canonical File", type: "Connector", service: "VAN Listener / FTP", description: "Receive inbound canonical file from trading partner." });
    steps.push({ number: String(n++), name: "Parse File Segments", type: "File Operation", description: `Parse canonical file into segments: ${[...new Set(mappings.map((m) => m.segment))].join(", ") || "HDR, DTL"}.` });
    steps.push({ number: String(n++), name: "Initialize Variables", type: "Variable Assignment", description: "Set batch number, counters, status flags." });
    if (exceptions.length > 0) steps.push({ number: String(n++), name: "Validate Inbound Data", type: "Rules", logic: exceptions.slice(0, 3).map((e) => e.length > 80 ? e.substring(0, 77) + "..." : e).join("\n"), description: "Validate required fields and business rules." });
    if (mappings.length > 0) steps.push({ number: String(n++), name: "Map to JDE Fields", type: "Service Request", service: "Field Transformation", description: `Map canonical fields to JDE columns. ${mappings.length} fields mapped.` });
    steps.push({ number: String(n++), name: "Insert into JDE Tables", type: "Loop", service: refs.tables.join(", ") || "F47011, F47012", description: `Insert records into ${refs.tables.join(", ") || "F47011, F47012"}.` });
    for (const ps of processSteps.slice(0, 4)) {
      if (ps.length > 10 && !steps.some((s) => s.description?.includes(ps.substring(0, 20)))) {
        steps.push({ number: String(n++), name: ps.length > 50 ? ps.substring(0, 47) + "..." : ps, type: /email|notif/i.test(ps) ? "Notification" : "Service Request", description: ps });
      }
    }
    if (/email|notif/i.test(text)) steps.push({ number: String(n++), name: "Email Notification", type: "Notification", description: "Send email notification based on Partner ID / Customer Group." });
    steps.push({ number: String(n++), name: "Log Results", type: "Variable Assignment", description: "Set return status, record count, and errors." });

  } else if (docType === "er") {
    const appMatch = text.match(/Listing of ER for Application\s*:\s*([^(]+)\s*\(([A-Z0-9]+)\)/i);
    const appId = appMatch ? appMatch[2].trim() : refs.apps[0] || "P0006";
    const appName = appMatch ? appMatch[1].trim() : "Application";
    const forms = []; let m; const formRx = /FORM:\s*(.+?)(?:\s*\[[^\]]*\])?\s*\(([A-Z0-9]+)\)/gi;
    while ((m = formRx.exec(text)) !== null) { if (!forms.some((f) => f.id === m[2])) forms.push({ id: m[2], name: m[1].trim() }); }
    const conditions = text.match(/^\d+\s+If\s+.+/gim) || [];
    steps.push({ number: String(n++), name: "Variable Assignment", type: "Variable Assignment", description: "Set variables from request inputs." });
    if (refs.tables.length > 0) steps.push({ number: String(n++), name: "Data Request", type: "Data Request", service: appId, description: `Retrieve data from ${refs.tables.slice(0, 4).join(", ")}.` });
    for (const bf of refs.bsfns.slice(0, 3)) steps.push({ number: String(n++), name: `Call ${bf}`, type: "Service Request", service: bf, description: `Call business function ${bf}.` });
    if (conditions.length > 0) steps.push({ number: String(n++), name: "Business Rules", type: "Rules", logic: conditions.slice(0, 3).map((c) => c.replace(/^\d+\s+/, "")).join("\n"), description: `${conditions.length} conditional rules.` });
    const formId = forms[0]?.id || "W" + appId.substring(1) + "A";
    steps.push({ number: String(n++), name: "Form Request", type: "Form Request", application: appId, form: formId, action: `Submit / ${forms[0]?.name || appName}`, description: `Submit form action in ${appId}.` });

  } else if (docType === "api-integration" || docType === "file-integration") {
    steps.push({ number: String(n++), name: "Receive Request", type: "Connector", service: /rest\s*api/i.test(text) ? "REST API Endpoint" : "Integration Trigger", description: "Receive inbound request with payload data." });
    steps.push({ number: String(n++), name: "Initialize Variables", type: "Variable Assignment", description: "Map request payload fields to orchestration variables." });
    // Extract JSON fields for variable mapping detail
    const jsonFields = text.match(/"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g) || [];
    const fieldNames = [...new Set(jsonFields.map((f) => f.replace(/["':]/g, "").trim()))];
    if (fieldNames.length > 0) {
      steps[steps.length - 1].description = `Map payload fields (${fieldNames.slice(0, 6).join(", ")}) to orchestration variables.`;
    }
    if (exceptions.length > 0) steps.push({ number: String(n++), name: "Validate Input Data", type: "Rules", logic: exceptions.slice(0, 3).join("\n"), description: "Validate required fields and business rules." });
    // Add process-specific steps from extracted processSteps
    for (const ps of processSteps.slice(0, 8)) {
      const st = /api|call\s*out|endpoint|quote/i.test(ps) ? "Connector" : /screen|form|P\d{4,6}/i.test(ps) ? "Form Request" : /table|UDC/i.test(ps) ? "Data Request" : /exclude|filter|if\b/i.test(ps) ? "Condition" : /email|notif/i.test(ps) ? "Notification" : "Service Request";
      const am = ps.match(/\b(P\d{4,6}[A-Z]?)\b/);
      steps.push({ number: String(n++), name: ps.length > 60 ? ps.substring(0, 57) + "..." : ps, type: st, ...(am ? { application: am[1] } : {}), description: ps });
    }
    // If no process steps were extracted, infer from document content
    if (processSteps.length === 0) {
      const hasLines = /\blines\b/i.test(text) || /\bline\s*item/i.test(text) || /\bfor\s*each/i.test(text) || /\bper\s*record/i.test(text);
      if (/po\s*requisition|purchase\s*order/i.test(text)) {
        steps.push({ number: String(n++), name: "Validate Supplier and Items", type: "Rules", description: "Validate supplier (AN8), branch/plant (MCU), item numbers, and quantities against JDE master data." });
        if (hasLines) steps.push({ number: String(n++), name: "Loop Through Line Items", type: "Loop", description: "Process each line item from the payload (item, quantity, price, UOM)." });
        steps.push({ number: String(n++), name: "Create PO Requisition", type: "Form Request", application: refs.apps[0] || "P4310", description: "Submit PO Requisition via form request. Create header and detail records." });
      } else if (/quick\s*hire|employee/i.test(text)) {
        steps.push({ number: String(n++), name: "Validate Employee Data", type: "Rules", description: "Validate employee fields (name, address, hire date, etc.) against JDE requirements." });
        steps.push({ number: String(n++), name: "Execute Quick Hire", type: "Form Request", application: refs.apps[0] || "P060116Q", description: "Emulate Quick Hire form interaction to create employee record." });
      } else if (/sales\s*order/i.test(text)) {
        if (hasLines) steps.push({ number: String(n++), name: "Loop Through Order Lines", type: "Loop", description: "Process each order line from the payload." });
        steps.push({ number: String(n++), name: "Create Sales Order", type: "Form Request", application: refs.apps[0] || "P4210", description: "Submit Sales Order via form request." });
      } else if (/benefit|enroll/i.test(text)) {
        steps.push({ number: String(n++), name: "Process Enrollment", type: "Form Request", application: refs.apps[0] || "P08334", description: "Submit benefit enrollment selections." });
      } else if (refs.apps.length > 0) {
        steps.push({ number: String(n++), name: `Execute ${refs.apps[0]}`, type: "Form Request", application: refs.apps[0], description: `Process transaction in ${refs.apps[0]}.` });
      }
    }
    if (refs.apps.length > 0 && !steps.some((s) => s.type === "Form Request")) steps.push({ number: String(n++), name: `Execute ${refs.apps[0]}`, type: "Form Request", application: refs.apps[0], description: `Interact with ${refs.apps[0]}.` });
    if (/email|notif/i.test(text)) steps.push({ number: String(n++), name: "Send Notification", type: "Notification", description: "Email notification with result." });
    steps.push({ number: String(n++), name: "Return Response", type: "Variable Assignment", description: /po\s*requisition/i.test(text) ? "Return order number, type, company on success or error description on failure." : "Set return status and generated IDs." });

  } else if (docType === "tax-integration") {
    steps.push({ number: String(n++), name: "Initialize Tax Request", type: "Variable Assignment", description: "Set tax calculation parameters." });
    steps.push({ number: String(n++), name: "Call Avalara Tax API", type: "Connector", service: "Avalara AvaTax API", description: "Send tax calculation request to Avalara." });
    for (const bf of refs.bsfns.slice(0, 3)) steps.push({ number: String(n++), name: `Execute BSFN ${bf}`, type: "Service Request", service: bf, description: `Call business function ${bf}.` });
    for (const ps of processSteps.slice(0, 6)) {
      steps.push({ number: String(n++), name: ps.length > 60 ? ps.substring(0, 57) + "..." : ps, type: /B\d{4,6}/.test(ps) ? "Service Request" : /P\d{4,6}/.test(ps) ? "Form Request" : "Service Request", description: ps });
    }
    steps.push({ number: String(n++), name: "Return Tax Results", type: "Variable Assignment", description: "Return tax amounts, GeoCode, status." });

  } else if (docType === "form-integration") {
    steps.push({ number: String(n++), name: "Receive Input Data", type: "Connector", service: /rest\s*api/i.test(text) ? "REST API" : /ftp|file/i.test(text) ? "FTP / File" : "Trigger", description: "Receive input data." });
    steps.push({ number: String(n++), name: "Initialize Variables", type: "Variable Assignment", description: "Map input fields to form variables." });
    steps.push({ number: String(n++), name: "Validate Data", type: "Rules", description: "Validate required fields and cross-references." });
    for (const app of refs.apps.slice(0, 2)) steps.push({ number: String(n++), name: `Submit to ${app}`, type: "Form Request", application: app, description: `Emulate form interaction with ${app}.` });
    if (refs.apps.length === 0) steps.push({ number: String(n++), name: "Submit Form", type: "Form Request", description: "Emulate form interaction to create record." });
    for (const ps of processSteps.slice(0, 5)) {
      if (!steps.some((s) => s.description?.includes(ps.substring(0, 20)))) steps.push({ number: String(n++), name: ps.length > 60 ? ps.substring(0, 57) + "..." : ps, type: "Service Request", description: ps });
    }
    if (/email|notif/i.test(text)) steps.push({ number: String(n++), name: "Email Notification", type: "Notification", description: "Send email with result." });
    steps.push({ number: String(n++), name: "Return Result", type: "Variable Assignment", description: "Set output: generated ID, status, errors." });

  } else {
    steps.push({ number: String(n++), name: "Initialize", type: "Variable Assignment", description: "Set processing variables." });
    for (const ps of processSteps.slice(0, 10)) {
      const st = /query|read|fetch|get|retriev/i.test(ps) ? "Data Request" : /valid|check|if\b/i.test(ps) ? "Rules" : /form|P\d{4,6}/i.test(ps) ? "Form Request" : /api|connect|ftp/i.test(ps) ? "Connector" : /loop|each|batch/i.test(ps) ? "Loop" : /email|notif/i.test(ps) ? "Notification" : /file|write|output/i.test(ps) ? "File Operation" : "Service Request";
      steps.push({ number: String(n++), name: ps.length > 60 ? ps.substring(0, 57) + "..." : ps, type: st, description: ps });
    }
    steps.push({ number: String(n++), name: "Return Status", type: "Variable Assignment", description: "Set final status and return values." });
  }
  return steps;
}

function buildOutputs(docType, refs, mappings, text) {
  if (docType === "edi-outbound") return ["Canonical output file (FTP)", "Processing status per record", "Exception/error report", "Record count (processed / skipped / errors)"];
  if (docType === "edi-inbound") return [`Records inserted into ${refs.tables.join(", ") || "F47011, F47012"}`, "Processing status", "Error/exception report", ...((/email/i.test(text)) ? ["Email notification"] : [])];
  if (docType === "er") return ["Status", "cErrorCode", ...(refs.aliases.includes("DOCO") ? ["Order Number (DOCO)"] : [])];
  if (docType === "api-integration") {
    const outs = ["Processing status (success / error)"];
    if (/po\s*requisition|purchase\s*order/i.test(text)) { outs.push("Order Number (DOCO)"); outs.push("Order Type"); outs.push("Company"); }
    else if (/quick\s*hire|employee/i.test(text)) outs.push("Employee ID");
    else outs.push("Generated record ID(s)");
    if (/email/i.test(text)) outs.push("Email notification confirmation");
    outs.push("Error description (if applicable)");
    return outs;
  }
  if (docType === "tax-integration") return ["Calculated tax amount", "GeoCode / Tax Area", "Status"];
  if (docType === "form-integration") return ["Generated record ID", "Processing status", ...((/email/i.test(text)) ? ["Email notification"] : []), "Error description (if applicable)"];
  return ["Processing status", "Result data / generated IDs", "Error details"];
}

function toMarkdown(result) {
  if (!result) return "";
  let md = `## 1. Orchestration Name\n<${result.orchName}>\n\n`;
  md += `## 2. Inputs\n${result.inputs.map((i) => `- ${i}`).join("\n")}\n\n`;
  md += `## 3. Variables\n${result.variables.map((v) => `- ${v}`).join("\n")}\n\n`;
  md += `## 4. Step-by-Step Orchestration Flow\n\n`;
  for (const s of result.steps) {
    md += `Step ${s.number} \u2013 ${s.name}\nType: ${s.type}\n`;
    if (s.service) md += `Service: ${s.service}\n`;
    if (s.application) md += `Application: ${s.application}\n`;
    if (s.form) md += `Form: ${s.form}\n`;
    if (s.action) md += `Action: ${s.action}\n`;
    if (s.logic) md += `Logic:\n${s.logic}\n`;
    if (s.description) md += `Description: ${s.description}\n`;
    md += "\n";
  }
  md += `## 5. Returned Outputs\n${result.outputs.map((o) => `- ${o}`).join("\n")}\n`;
  return md;
}

/* ═══════════════════════════════════════════════════════════
   UI COMPONENTS
   ═══════════════════════════════════════════════════════════ */

const stepTypeColorMap = {
  "Variable Assignment": { bg: "#1a2740", border: "#3b82f6", accent: "#60a5fa" },
  "Data Request": { bg: "#1a2d2a", border: "#10b981", accent: "#34d399" },
  "Service Request": { bg: "#2a1a2d", border: "#a78bfa", accent: "#c4b5fd" },
  Rules: { bg: "#2d2a1a", border: "#f59e0b", accent: "#fbbf24" },
  Condition: { bg: "#2d2a1a", border: "#f59e0b", accent: "#fbbf24" },
  "Form Request": { bg: "#1a2740", border: "#06b6d4", accent: "#22d3ee" },
  Loop: { bg: "#2a1a2d", border: "#c084fc", accent: "#d8b4fe" },
  Connector: { bg: "#1a2d2a", border: "#14b8a6", accent: "#2dd4bf" },
  Notification: { bg: "#2d1f1a", border: "#f97316", accent: "#fb923c" },
  "File Operation": { bg: "#1f2d1a", border: "#84cc16", accent: "#a3e635" },
};
function getStepColors(type) { for (const [k, c] of Object.entries(stepTypeColorMap)) { if (type.toLowerCase().includes(k.toLowerCase())) return c; } return { bg: "#1e293b", border: "#64748b", accent: "#94a3b8" }; }
const sectionLabel = { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b" };
const btnSecondary = { background: "transparent", color: "#94a3b8", border: "1px solid #334155", borderRadius: 6, padding: "8px 14px", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" };

function BulletCard({ title, color, items, maxHeight }) {
  return (
    <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: "14px 16px", overflow: "auto", ...(maxHeight ? { maxHeight } : {}) }}>
      <div style={{ ...sectionLabel, color, marginBottom: 8 }}>{title}</div>
      {items.length > 0 ? items.map((item, i) => (
        <div key={i} style={{ fontSize: 12, color: "#94a3b8", padding: "3px 0", borderBottom: i < items.length - 1 ? "1px solid #1e293b" : "none", fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.5 }}>{item}</div>
      )) : <div style={{ fontSize: 12, color: "#475569" }}>None detected</div>}
    </div>
  );
}

function StepCard({ step }) {
  const sc = getStepColors(step.type);
  return (
    <div style={{ background: sc.bg, borderLeft: `3px solid ${sc.border}`, border: `1px solid ${sc.border}25`, borderLeftWidth: 3, borderLeftStyle: "solid", borderLeftColor: sc.border, borderRadius: 6, marginBottom: 8, padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ background: sc.border, color: "#0b1120", borderRadius: "50%", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>{step.number}</span>
        <span style={{ fontWeight: 600, fontSize: 14, color: "#f1f5f9" }}>{step.name}</span>
        {step.type && <span style={{ background: sc.border + "20", color: sc.accent, border: `1px solid ${sc.border}40`, borderRadius: 4, padding: "1px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>{step.type}</span>}
      </div>
      <div style={{ marginLeft: 32 }}>
        {step.service && <div style={{ fontSize: 12, color: "#64748b" }}><span style={{ color: "#94a3b8" }}>Service:</span> <span style={{ color: sc.accent, fontFamily: "'JetBrains Mono', monospace" }}>{step.service}</span></div>}
        {step.application && <div style={{ fontSize: 12, color: "#64748b" }}><span style={{ color: "#94a3b8" }}>Application:</span> <span style={{ color: sc.accent, fontFamily: "'JetBrains Mono', monospace" }}>{step.application}</span></div>}
        {step.form && <div style={{ fontSize: 12, color: "#64748b" }}><span style={{ color: "#94a3b8" }}>Form:</span> <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{step.form}</span></div>}
        {step.action && <div style={{ fontSize: 12, color: "#64748b" }}><span style={{ color: "#94a3b8" }}>Action:</span> {step.action}</div>}
        {step.logic && <div style={{ fontSize: 12, color: sc.accent, marginTop: 4, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "pre-wrap", background: "#00000030", padding: "6px 10px", borderRadius: 4, lineHeight: 1.5 }}>{step.logic}</div>}
        {step.description && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2, lineHeight: 1.5 }}>{step.description}</div>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   AIS CONNECTION PANEL
   ═══════════════════════════════════════════════════════════ */

const DEFAULT_API_URL = import.meta.env.VITE_AIS_API_URL || "http://localhost:8000";

function AISConnectionPanel({ creds, setCreds, connStatus, onTest }) {
  const [showPanel, setShowPanel] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const statusColor = { idle: "#64748b", testing: "#f59e0b", connected: "#10b981", error: "#ef4444" }[connStatus.state];
  const statusDot = connStatus.state !== "idle";

  const inputStyle = {
    width: "100%", background: "#0f172a", border: "1px solid #1e293b", borderRadius: 5,
    color: "#e2e8f0", fontSize: 12, padding: "6px 10px", fontFamily: "'JetBrains Mono', monospace",
    outline: "none", boxSizing: "border-box",
  };
  const labelStyle = { fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "#475569", marginBottom: 3, display: "block" };

  return (
    <div style={{ borderTop: "1px solid #1e293b", flexShrink: 0 }}>
      {/* Toggle bar */}
      <div
        onClick={() => setShowPanel(p => !p)}
        style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", background: "#0c1526" }}
      >
        <span style={{ fontSize: 10, color: statusColor, lineHeight: 1 }}>{statusDot ? "●" : "○"}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.07em", flex: 1 }}>AIS Connection</span>
        {connStatus.state === "connected" && (
          <span style={{ fontSize: 10, color: "#10b981", background: "#10b98115", border: "1px solid #10b98130", borderRadius: 3, padding: "1px 6px" }}>
            {connStatus.message}
          </span>
        )}
        {connStatus.state === "error" && (
          <span style={{ fontSize: 10, color: "#ef4444", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{connStatus.message}</span>
        )}
        <span style={{ fontSize: 10, color: "#334155" }}>{showPanel ? "▲" : "▼"}</span>
      </div>

      {showPanel && (
        <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 8, background: "#080f1e" }}>
          <div>
            <label style={labelStyle}>AIS Base URL</label>
            <input style={inputStyle} value={creds.base_url} onChange={e => setCreds(p => ({ ...p, base_url: e.target.value }))} placeholder="https://your-jde-server/jderest" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>Username</label>
              <input style={inputStyle} value={creds.username} onChange={e => setCreds(p => ({ ...p, username: e.target.value }))} placeholder="JDEUSER" />
            </div>
            <div>
              <label style={labelStyle}>Password</label>
              <div style={{ position: "relative" }}>
                <input style={{ ...inputStyle, paddingRight: 28 }} type={showPassword ? "text" : "password"} value={creds.password} onChange={e => setCreds(p => ({ ...p, password: e.target.value }))} placeholder="••••••••" />
                <button onClick={() => setShowPassword(s => !s)} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 11, padding: 0 }}>{showPassword ? "hide" : "show"}</button>
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>Timeout (s)</label>
              <input style={inputStyle} type="number" value={creds.timeout} onChange={e => setCreds(p => ({ ...p, timeout: parseInt(e.target.value) || 30 }))} />
            </div>
            <div>
              <label style={labelStyle}>API Server URL</label>
              <input style={inputStyle} value={creds.api_url} onChange={e => setCreds(p => ({ ...p, api_url: e.target.value }))} placeholder="http://localhost:8000" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button
              onClick={onTest}
              disabled={connStatus.state === "testing" || !creds.base_url || !creds.username || !creds.password}
              style={{ flex: 1, background: connStatus.state === "testing" ? "#1e293b" : "#1e3a5f", color: connStatus.state === "testing" ? "#64748b" : "#60a5fa", border: "1px solid #2563eb40", borderRadius: 5, padding: "6px 0", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
            >
              {connStatus.state === "testing" ? "Testing…" : "Test Connection"}
            </button>
          </div>
          <div style={{ fontSize: 10, color: "#334155", lineHeight: 1.5 }}>
            Credentials are not stored. Start the Python backend with <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#475569" }}>uvicorn main:app</span> in <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#475569" }}>/server</span>.
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════ */

export default function App() {
  const [inputText, setInputText] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState(null);
  const [rawMarkdown, setRawMarkdown] = useState("");
  const [error, setError] = useState(null);
  const [copyState, setCopyState] = useState("idle");
  const [dragOver, setDragOver] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const fileInputRef = useRef(null);

  // AIS connection state
  const [creds, setCreds] = useState({
    base_url: "",
    username: "",
    password: "",
    timeout: 30,
    verify_ssl: true,
    api_url: DEFAULT_API_URL,
  });
  const [connStatus, setConnStatus] = useState({ state: "idle", message: "" });
  const handleFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    try {
      const text = await loadFileContent(file);
      if (!text.trim()) { setError(`No readable text in "${file.name}".`); return; }
      setInputText(text);
    } catch { setError(`Could not read "${file.name}". Supported: .txt, .docx`); }
  };

  const handleTranslate = () => {
    if (!inputText.trim()) return;
    setError(null);
    try {
      const parsed = translateDocument(inputText);
      if (!parsed) { setError("Could not parse document."); return; }
      setResult(parsed);
      setRawMarkdown(toMarkdown(parsed));
    } catch (err) { setError(`Translation error: ${err.message}`); }
  };

  const handleClear = () => {
    setInputText(""); setFileName(""); setResult(null); setRawMarkdown("");
    setError(null); setShowRaw(false);
  };

  const handleCopy = async () => {
    if (!rawMarkdown) return;
    try { await navigator.clipboard.writeText(rawMarkdown); setCopyState("copied"); } catch { setCopyState("failed"); }
    setTimeout(() => setCopyState("idle"), 2000);
  };

  // AIS: test connection
  const handleTestConnection = async () => {
    setConnStatus({ state: "testing", message: "Connecting…" });
    try {
      const res = await fetch(`${creds.api_url}/api/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: {
            base_url: creds.base_url,
            username: creds.username,
            password: creds.password,
            timeout: creds.timeout,
            verify_ssl: creds.verify_ssl,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Connection failed");
      setConnStatus({ state: "connected", message: data.message || "Connected" });
    } catch (e) {
      setConnStatus({ state: "error", message: e.message });
    }
  };

  const hasOutput = !!result;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      <header style={{ borderBottom: "1px solid #1e293b", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0f172a", flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", color: "#f1f5f9" }}>JDE Design Spec Translator</h1>
          <p style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Design Spec / ER &rarr; Orchestration Steps</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleTranslate} disabled={!inputText.trim()} style={{ background: !inputText.trim() ? "#1e293b" : "#3b82f6", color: !inputText.trim() ? "#64748b" : "#fff", border: "none", borderRadius: 6, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: !inputText.trim() ? "default" : "pointer", opacity: !inputText.trim() ? 0.4 : 1, fontFamily: "inherit" }}>Translate</button>
          {rawMarkdown && <button onClick={handleCopy} style={btnSecondary}>{copyState === "copied" ? "Copied" : "Copy"}</button>}
          <button onClick={handleClear} style={btnSecondary}>Clear</button>
        </div>
      </header>

      {error && <div style={{ margin: "12px 24px 0", padding: "10px 16px", background: "#2d0d15", border: "1px solid #991b1b", borderRadius: 6, color: "#fca5a5", fontSize: 13 }}>{error}</div>}

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: hasOutput ? "380px 1fr" : "1fr", gap: 0, overflow: "hidden", minHeight: 0 }}>
        {/* Left panel: input + AIS connector */}
        <div style={{ borderRight: hasOutput ? "1px solid #1e293b" : "none", display: "flex", flexDirection: "column", overflow: "hidden", maxWidth: hasOutput ? 380 : 720, margin: hasOutput ? 0 : "0 auto", width: "100%" }}>
          <div style={{ padding: "12px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={sectionLabel}>Input</span>
            {fileName && <span style={{ fontSize: 11, color: "#3b82f6", background: "#1e3a5f", padding: "2px 8px", borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</span>}
          </div>
          <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }} onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }} style={{ margin: "0 12px", padding: "8px 12px", border: `1px dashed ${dragOver ? "#3b82f6" : "#334155"}`, borderRadius: 6, background: dragOver ? "#1e3a5f22" : "transparent", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#64748b", flexShrink: 0 }}>
            <button onClick={() => fileInputRef.current?.click()} style={{ background: "#1e293b", border: "1px solid #334155", color: "#94a3b8", borderRadius: 4, padding: "4px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Choose file</button>
            <span>or drop .docx / .txt here</span>
            <input ref={fileInputRef} type="file" accept=".txt,.docx,.md,.xml" onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }} style={{ display: "none" }} />
          </div>
          <textarea value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Paste design spec, ER text, or upload a file..." spellCheck={false} style={{ flex: 1, margin: "8px 12px 0", padding: 12, background: "#0f172a", border: "1px solid #1e293b", borderRadius: 6, color: "#cbd5e1", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6, resize: "none", outline: "none", minHeight: 200 }} />

          {/* AIS Panel always visible at bottom of left column */}
          <AISConnectionPanel
            creds={creds}
            setCreds={setCreds}
            connStatus={connStatus}
            onTest={handleTestConnection}
          />
        </div>

        {hasOutput && (
          <div style={{ overflow: "auto", padding: "16px 24px" }}>
            <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: "16px 20px", marginBottom: 16 }}>
              <div>
                <div style={{ ...sectionLabel, marginBottom: 4 }}>Orchestration</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9" }}>{result.orchName}</div>
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
                {[{ l: "Steps", v: result.steps.length, c: "#3b82f6" }, { l: "Inputs", v: result.inputs.length, c: "#10b981" }, { l: "Variables", v: result.variables.length, c: "#a78bfa" }, { l: "Outputs", v: result.outputs.length, c: "#f59e0b" }].map((s) => (
                  <div key={s.l} style={{ background: s.c + "12", border: `1px solid ${s.c}30`, borderRadius: 6, padding: "6px 12px", display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontSize: 18, fontWeight: 800, color: s.c, fontFamily: "'JetBrains Mono', monospace" }}>{s.v}</span>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{s.l}</span>
                  </div>
                ))}
              </div>
            </div>


            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              <BulletCard title="Inputs" color="#10b981" items={result.inputs} />
              <BulletCard title="Variables" color="#a78bfa" items={result.variables} maxHeight={260} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...sectionLabel, marginBottom: 10 }}>Orchestration Flow &mdash; {result.steps.length} Steps</div>
              {result.steps.map((step, i) => <StepCard key={i} step={step} />)}
            </div>
            <BulletCard title="Returned Outputs" color="#f59e0b" items={result.outputs} />
            <div style={{ marginTop: 16, marginBottom: 32 }}>
              <button onClick={() => setShowRaw(!showRaw)} style={{ background: "transparent", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer", padding: "6px 0", fontFamily: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}>{showRaw ? "Hide" : "View"} raw markdown</button>
              {showRaw && <pre style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 6, padding: 12, fontSize: 11, color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "pre-wrap", lineHeight: 1.6, marginTop: 8, maxHeight: 400, overflow: "auto" }}>{rawMarkdown}</pre>}
            </div>
          </div>
        )}

        {!hasOutput && inputText.trim() && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#475569", textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: "#64748b" }}>Click Translate to generate orchestration steps</div>
          </div>
        )}
      </div>
    </div>
  );
}
