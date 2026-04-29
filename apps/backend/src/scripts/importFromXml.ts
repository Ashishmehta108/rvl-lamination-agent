import fs from "node:fs";
import path from "node:path";

/**
 * Regex-based XML parser (no dependencies required)
 * Converts t.xml tags into the format required by:
 * PUT /machines/:machineId/revisions/:rev/definitions
 */

const XML_PATH = path.join(process.cwd(), "t.xml");
const HMI_ALARMS_PATH = path.join(process.cwd(), "hmi_alarms.xml");
const OUTPUT_PATH = path.join(process.cwd(), "tag_definitions.json");

function getTagValue(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`));
  return match ? match[1].trim() : "";
}

/**
 * Category-specific threshold rules
 */
const TAG_RULES: Record<string, { warn: number; alarm: number }> = {
  RPM: { warn: 0.85, alarm: 0.92 },
  AMP: { warn: 0.80, alarm: 0.90 },
  MPM: { warn: 0.90, alarm: 0.95 },
  VOL: { warn: 0.92, alarm: 0.98 },
  DEFAULT: { warn: 0.90, alarm: 0.95 },
};

const TAG_SPECIFIC_OVERRIDES: Record<string, { warn?: number; alarm?: number }> = {
  "EXTRUDER_1_SCREW_1_ACT_RPM_D1104": { warn: 85, alarm: 95 },
  "LAMINATOR_ACT_MPM_D1106": { warn: 75, alarm: 85 },
};

async function convert() {
  if (!fs.existsSync(XML_PATH)) {
    console.error(`File not found: ${XML_PATH}`);
    return;
  }

  const xmlData = fs.readFileSync(XML_PATH, "utf-8");
  const hmiData = fs.existsSync(HMI_ALARMS_PATH) ? fs.readFileSync(HMI_ALARMS_PATH, "utf-8") : "";
  
  const tagBlocks = xmlData.split("</tag>");
  console.log(`Found ${tagBlocks.length - 1} potential tag blocks...`);

  // ── Parse Alarms Section from HMI Data ──
  const alarmMap: Record<string, string> = {};
  if (hmiData) {
    const alarmBlocks = hmiData.split("</alarm>");
    alarmBlocks.forEach(block => {
      const source = getTagValue(block, "source");
      const name = getTagValue(block, "name");
      if (source && name && name !== "n/a") {
        alarmMap[source] = name;
      }
    });
  }
  console.log(`Extracted ${Object.keys(alarmMap).length} real alarm mappings from HMI data.`);


  const definitions = tagBlocks
    .map(block => {
      const name = getTagValue(block, "name");
      if (!name || name === "n/a") return null;

      const dataTypeRaw = getTagValue(block, "data_type");
      let dataType: "number" | "boolean" | "string" = "number";
      if (dataTypeRaw === "boolean" || alarmMap[name]) dataType = "boolean";

      const scalingMatch = block.match(/<scaling>([\s\S]*?)<\/scaling>/);
      const scalingBlock = scalingMatch ? scalingMatch[1] : "";
      const min = Number(getTagValue(scalingBlock, "eumin")) || 0;
      const max = Number(getTagValue(scalingBlock, "eumax")) || 0;

      // ── Threshold Calculation ──
      let warnHigh: number | undefined;
      let alarmHigh: number | undefined;
      let displayName = name.split("_").slice(0, -1).join(" ") || name;

      // Check if this tag is a known Alarm from the <alarms> section
      if (alarmMap[name]) {
        displayName = alarmMap[name];
        warnHigh = undefined;
        alarmHigh = 1; // Binary fault: Alarm when 1
        dataType = "boolean";
      } else if (max > 0) {
        const override = TAG_SPECIFIC_OVERRIDES[name];
        if (override) {
          warnHigh = override.warn;
          alarmHigh = override.alarm;
        } else {
          const ruleKey = Object.keys(TAG_RULES).find(key => name.includes(key)) || "DEFAULT";
          const rule = TAG_RULES[ruleKey];
          warnHigh = Number((max * rule.warn).toFixed(2));
          alarmHigh = Number((max * rule.alarm).toFixed(2));
        }
      }

      return {
        tagId: name,
        slug: name,
        name: displayName,
        dataType,
        unit: name.includes("RPM") ? "RPM" : name.includes("AMP") ? "A" : name.includes("MPM") ? "m/min" : undefined,
        min,
        max,
        warnHigh,
        alarmHigh,
        sampleEveryMs: Number(getTagValue(block, "refreshTime")) || 500,
      };
    })
    .filter(Boolean);


  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(definitions, null, 2));
  console.log(`Done! Created ${definitions.length} definitions in ${OUTPUT_PATH}`);
}


convert().catch(console.error);
