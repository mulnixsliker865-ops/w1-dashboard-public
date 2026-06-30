import fs from "node:fs";
import path from "node:path";

const APP_TOKEN = process.env.FEISHU_BASE_APP_TOKEN || "LROebpuy6akvMSsfAlDcKx3Kn2c";
const LEAD_TABLE_ID = process.env.FEISHU_LEAD_TABLE_ID || "tbl2HIr7jiHY4PXz";
const ASSIGNMENT_TABLE_ID = process.env.FEISHU_ASSIGNMENT_TABLE_ID || "tbl3yc7EZT05fczy";
const GEO_REPORT_CODE = process.env.GEO_REPORT_CODE || "Wif1YgmEVhv_BgISAi-tTA";
const XUNLING_BASE_URL = process.env.XUNLING_BASE_URL || "https://www.xunlingai.com";
const OUTPUT = path.resolve("dashboard-data.js");

const TABLES = {
  leads: { name: "2026年线索表新", id: LEAD_TABLE_ID },
  assignments: { name: "是否派单", id: ASSIGNMENT_TABLE_ID }
};

const EMPTY_CHANNEL_VALUES = new Set(["", "无", "待补", "待补充", "未知", "-", "--", "null", "undefined"]);
const TIANJIN_DISTRICTS = [
  "和平区", "河东区", "河西区", "南开区", "河北区", "红桥区",
  "东丽区", "西青区", "津南区", "北辰区", "武清区", "宝坻区",
  "滨海新区", "宁河区", "宁河县", "静海区", "静海县", "蓟州区", "蓟县"
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function feishuFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Feishu returned non-JSON response for ${url}: ${text.slice(0, 200)}`);
  }
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || `Feishu API failed: ${url}`);
  }
  return payload;
}

async function getTenantAccessToken() {
  const appId = requireEnv("FEISHU_APP_ID");
  const appSecret = requireEnv("FEISHU_APP_SECRET");
  const payload = await feishuFetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  return payload.tenant_access_token;
}

async function fetchRecords(token, tableId) {
  const records = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);
    const payload = await feishuFetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    records.push(...(payload.data?.items || []));
    pageToken = payload.data?.has_more ? payload.data.page_token : "";
  } while (pageToken);
  return records;
}

function cleanText(value) {
  if (Array.isArray(value)) return cleanText(value.map(item => item?.text ?? item?.name ?? item).join(""));
  if (value && typeof value === "object") return cleanText(value.text ?? value.name ?? value.value ?? "");
  return String(value ?? "").trim();
}

function firstField(fields, names) {
  for (const name of names) {
    const value = fields[name];
    if (value !== undefined && value !== null && cleanText(value) !== "") return value;
  }
  return "";
}

function cleanChannelPart(value, fallback = "其他") {
  const text = cleanText(value);
  return EMPTY_CHANNEL_VALUES.has(text) ? fallback : text;
}

function normalizeChannelLevels(fields) {
  let l1 = cleanText(firstField(fields, ["来源渠道一级", "source_channel_level1"]));
  let l2 = cleanText(firstField(fields, ["来源渠道二级", "source_channel_level2"]));
  let l3 = cleanText(firstField(fields, ["来源渠道三级", "source_channel_level3"]));
  let l4 = cleanText(firstField(fields, ["来源渠道四级", "source_channel_level4"]));

  if (!l1 || !l2 || !l3 || !l4) {
    const raw = cleanText(firstField(fields, [
      "新来源渠道",
      "new_source_channel",
      "来源渠道",
      "source_channel",
      "source_channel_old"
    ]));
    if (raw.includes("-")) {
      const parts = raw.split("-").map(part => part.trim()).filter(Boolean);
      l1 ||= parts[0] || "";
      l2 ||= parts[1] || "";
      l3 ||= parts[2] || "";
      l4 ||= parts.slice(3).join("-");
    }
  }

  l1 = cleanChannelPart(l1);
  l2 = cleanChannelPart(l2);

  if (l2 === "自然客流") return { l1, l2, l3: "自然客流", l4: "自然客流" };
  return {
    l1,
    l2,
    l3: cleanChannelPart(l3),
    l4: cleanChannelPart(l4)
  };
}

function toDateString(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(value));
  }
  const text = cleanText(value);
  const match = text.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (match) {
    const [, year, month, day] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return "";
}

function normalizePhone(value) {
  return cleanText(value).replace(/\s+/g, "");
}

function normalizeDistrict(value) {
  const text = cleanText(value);
  if (!text || !text.includes("天津")) return "其他";
  return TIANJIN_DISTRICTS.find(district => text.includes(district)) || "其他";
}

function numberValue(value, fallback = 0) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : fallback;
}

function readPreviousGeoData() {
  if (!fs.existsSync(OUTPUT)) return null;
  const text = fs.readFileSync(OUTPUT, "utf8");
  const match = text.match(/window\.feishuDashboardData\s*=\s*(\{[\s\S]*\});?\s*$/);
  if (!match) return null;
  try {
    return Function(`"use strict"; return (${match[1]});`)()?.geo || null;
  } catch {
    return null;
  }
}

async function xunlingJson(pathname, { method = "GET", params = {}, body = null, headers = {} } = {}) {
  const url = new URL(pathname, XUNLING_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });

  const options = {
    method,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json, text/plain, */*",
      "aeuid": GEO_REPORT_CODE,
      ...headers
    }
  };
  if (body) options.body = body;

  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Xunling returned non-JSON response for ${url}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`Xunling API failed ${response.status}: ${url}`);
  return payload;
}

async function fetchGeoData() {
  const fetchedAt = new Date().toISOString();

  const [
    topKeywords,
    collectionTrend,
    collectionTotal,
    platformCounts,
    visibleCount,
    transform
  ] = await Promise.all([
    xunlingJson("/zl/aiSearchRanking/topKeywords"),
    xunlingJson("/zlv3/aiSearchRanking/historyRankingDetailV3", { params: { queryDays: 30 } }),
    xunlingJson("/zlv3/aiSearchRanking/historyRankingStatisticsV3"),
    xunlingJson("/zlv3/aiSearchRanking/statisticspV3"),
    xunlingJson("/dyseo/loose/aiwash/getVisibleCount", { params: { aeuid: GEO_REPORT_CODE } }),
    xunlingJson("/digital/Wx/H5/Web/Transform", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ key: GEO_REPORT_CODE })
    })
  ]);

  const token = Object.keys(transform?.data || {})[0] || "";
  const outline = token
    ? await xunlingJson("/kefu/anchor/getOutline", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Authorization": `Bearer ${token}`
        },
        body: new URLSearchParams({})
      })
    : null;

  const platformList = Array.isArray(platformCounts?.result) ? platformCounts.result : [];
  const trend = Array.isArray(collectionTrend?.result?.statistics)
    ? collectionTrend.result.statistics
        .map(item => ({
          date: toDateString(item.totalDate),
          value: numberValue(item.totalNumber)
        }))
        .filter(item => item.date)
        .sort((a, b) => a.date.localeCompare(b.date))
    : [];

  const recommendationCount = platformList.reduce((sum, item) => sum + numberValue(item.count), 0);
  const latestTrendValue = trend.length ? trend[trend.length - 1].value : 0;

  return {
    status: "ok",
    fetchedAt,
    source: {
      reportUrl: `${XUNLING_BASE_URL}/#/ai_report?code=${GEO_REPORT_CODE}`,
      reportCode: GEO_REPORT_CODE
    },
    metrics: {
      trainingWords: numberValue(topKeywords?.result?.count),
      recommendationWords: recommendationCount || latestTrendValue,
      totalCollected: numberValue(collectionTotal?.result),
      leadEvents: numberValue(outline?.data?.items?.[1]),
      websiteEvents: numberValue(visibleCount?.data?.weburl_count),
      phoneEvents: numberValue(visibleCount?.data?.mobile_count)
    },
    collectionTrend: trend,
    platformCounts: platformList
      .map(item => ({
        name: cleanText(item.name),
        type: cleanText(item.type),
        count: numberValue(item.count)
      }))
      .filter(item => item.name),
    topKeywords: Array.isArray(topKeywords?.result?.list)
      ? topKeywords.result.list.map(item => ({
          subject: cleanText(item.subject),
          count: numberValue(item.count),
          type: cleanText(item.type)
        }))
      : []
  };
}

async function fetchGeoDataSafely() {
  try {
    return await fetchGeoData();
  } catch (error) {
    const previousGeo = readPreviousGeoData();
    return {
      ...(previousGeo || {}),
      status: "error",
      fetchedAt: new Date().toISOString(),
      error: error.message || String(error),
      source: previousGeo?.source || {
        reportUrl: `${XUNLING_BASE_URL}/#/ai_report?code=${GEO_REPORT_CODE}`,
        reportCode: GEO_REPORT_CODE
      },
      metrics: previousGeo?.metrics || {},
      collectionTrend: previousGeo?.collectionTrend || [],
      platformCounts: previousGeo?.platformCounts || [],
      topKeywords: previousGeo?.topKeywords || []
    };
  }
}

function groupRows(rows, getKey, init, update) {
  const map = new Map();
  for (const row of rows) {
    const key = getKey(row);
    if (!map.has(key)) map.set(key, init(row));
    update(map.get(key), row);
  }
  return [...map.values()];
}

async function build() {
  const token = await getTenantAccessToken();
  const [leadRecords, assignmentRecords, geo] = await Promise.all([
    fetchRecords(token, TABLES.leads.id),
    fetchRecords(token, TABLES.assignments.id),
    fetchGeoDataSafely()
  ]);

  const rawLeadRows = leadRecords.map(record => {
    const fields = record.fields || {};
    return {
      createDate: toDateString(firstField(fields, ["创建时间", "created_at", "_created_date"])),
      createDept: cleanText(firstField(fields, ["创建部门", "create_dept", "sales_dept"])) || "其他",
      status: cleanText(firstField(fields, ["状态", "status", "_crm_status_snapshot"])) || "未处理",
      ...normalizeChannelLevels(fields)
    };
  }).filter(row => row.createDate);

  const rawAssignmentRows = assignmentRecords.map(record => {
    const fields = record.fields || {};
    return {
      name: cleanText(fields["客户姓名"]),
      phone: normalizePhone(fields["手机号码"]),
      assignDate: toDateString(fields["派设计部"]),
      channelDept: cleanText(fields["渠道部门"]) || "其他",
      district: normalizeDistrict(fields["省市区"]),
      ...normalizeChannelLevels(fields)
    };
  }).filter(row => row.assignDate && row.phone);

  const uniqueAssignmentRows = [...new Map(
    rawAssignmentRows.map(row => [[row.name, row.phone, row.assignDate].join("||"), row])
  ).values()];

  const leadRows = groupRows(
    rawLeadRows,
    row => [row.createDate, row.createDept, row.l1, row.l2, row.l3, row.l4].join("||"),
    row => ({
      createDate: row.createDate,
      createDept: row.createDept,
      l1: row.l1,
      l2: row.l2,
      l3: row.l3,
      l4: row.l4,
      total: 0,
      transferred: 0,
      pending: 0
    }),
    (group, row) => {
      group.total += 1;
      if (row.status === "转客户") group.transferred += 1;
      else group.pending += 1;
    }
  );

  const assignmentRows = groupRows(
    uniqueAssignmentRows,
    row => [row.assignDate, row.channelDept, row.l1, row.l2, row.l3, row.l4].join("||"),
    row => ({
      assignDate: row.assignDate,
      channelDept: row.channelDept,
      l1: row.l1,
      l2: row.l2,
      l3: row.l3,
      l4: row.l4,
      assignedCount: 0
    }),
    group => { group.assignedCount += 1; }
  );

  const assignmentDistrictRows = groupRows(
    uniqueAssignmentRows,
    row => [row.assignDate, row.channelDept, row.l1, row.l2, row.l3, row.l4, row.district].join("||"),
    row => ({
      assignDate: row.assignDate,
      channelDept: row.channelDept,
      l1: row.l1,
      l2: row.l2,
      l3: row.l3,
      l4: row.l4,
      district: row.district,
      assignedCount: 0
    }),
    group => { group.assignedCount += 1; }
  );

  const years = [...new Set([
    ...leadRows.map(row => row.createDate.slice(0, 4)),
    ...assignmentRows.map(row => row.assignDate.slice(0, 4))
  ].filter(Boolean))].sort();

  const departmentOptions = [...new Set([
    ...leadRows.map(row => row.createDept),
    ...assignmentRows.map(row => row.channelDept)
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      app: APP_TOKEN,
      leadTable: TABLES.leads,
      assignmentTable: TABLES.assignments
    },
    years,
    departmentOptions,
    leadRows,
    assignmentRows,
    assignmentDistrictRows,
    geo,
    counts: {
      leadRecords: leadRecords.length,
      usableLeadRows: rawLeadRows.length,
      aggregatedLeadRows: leadRows.length,
      assignmentRecords: assignmentRecords.length,
      usableAssignmentRows: rawAssignmentRows.length,
      uniqueAssignmentRows: uniqueAssignmentRows.length,
      aggregatedAssignmentRows: assignmentRows.length,
      aggregatedAssignmentDistrictRows: assignmentDistrictRows.length
    },
    privacy: "aggregated only; no customer names, phone numbers, or record ids"
  };

  fs.writeFileSync(OUTPUT, `window.feishuDashboardData = ${JSON.stringify(payload, null, 2)};\n`, "utf8");
  console.log(JSON.stringify(payload.counts, null, 2));
}

build().catch(error => {
  console.error(error);
  process.exit(1);
});
