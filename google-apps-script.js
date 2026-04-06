// =====================================================
// SHAFAT FARMTRACK - Google Apps Script v2 (Multi-User)
// =====================================================
//
// SETUP INSTRUCTIONS:
// 1. Go to https://sheets.google.com and create a new blank spreadsheet
// 2. Name it "ShaFat FarmTrack" (or anything you like)
// 3. Click Extensions > Apps Script
// 4. Delete any code in the editor and paste this ENTIRE file
// 5. Click the Save button (disk icon)
// 6. Click Deploy > New deployment (or Manage deployments to update)
// 7. Click the gear icon next to "Select type" and choose "Web app"
// 8. Set "Execute as" to "Me"
// 9. Set "Who has access" to "Anyone"
// 10. Click "Deploy"
// 11. Click "Authorize access" and follow the prompts
// 12. Copy the Web App URL — you'll paste it into the ShaFat FarmTrack app
//
// IMPORTANT: After deploying, create a "Users" sheet manually with columns:
//   pin | name | role
//   1234 | Fatah | admin
//   5678 | Worker1 | user
// =====================================================

// Sheet schemas: name -> column headers
var SCHEMAS = {
  'Ponds':        ['id', 'name', 'type', 'size', 'species', 'notes', 'createdAt', 'createdBy'],
  'Stockings':    ['id', 'pondId', 'qty', 'date', 'costPer', 'supplier', 'notes', 'createdBy'],
  'Mortalities':  ['id', 'pondId', 'qty', 'date', 'cause', 'notes', 'createdBy'],
  'Transactions': ['id', 'type', 'category', 'pondId', 'amount', 'date', 'desc', 'createdBy'],
  'Harvests':     ['id', 'pondId', 'qty', 'weight', 'date', 'notes', 'createdBy'],
  'Sales':        ['id', 'pondId', 'qty', 'weight', 'pricePerKg', 'total', 'buyer', 'date', 'createdBy']
};

// Map frontend data keys to sheet names
var KEY_TO_SHEET = {
  'ponds': 'Ponds',
  'stockings': 'Stockings',
  'mortalities': 'Mortalities',
  'transactions': 'Transactions',
  'harvests': 'Harvests',
  'sales': 'Sales'
};

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  var action = e.parameter.action;
  var output;

  try {
    switch (action) {
      case 'auth':
        output = authUser(e.parameter.pin);
        break;
      case 'loadAll':
        output = loadAllData();
        break;
      case 'add':
        output = addRecord(e.parameter.sheet, e.parameter.data);
        break;
      case 'update':
        output = updateRecord(e.parameter.sheet, e.parameter.id, e.parameter.data);
        break;
      case 'delete':
        output = deleteRecord(e.parameter.sheet, e.parameter.id);
        break;
      case 'migrate':
        output = migrateFromOldFormat();
        break;
      case 'fixHeaders':
        output = fixAllHeaders();
        break;
      // Keep backward compatibility for old app version
      case 'load':
        output = loadAllData();
        break;
      case 'save':
        var jsonData = e.parameter.data || (e.postData ? e.postData.contents : null);
        output = saveFullData(jsonData);
        break;
      default:
        output = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    output = { success: false, error: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(output))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============ AUTH ============

function authUser(pin) {
  if (!pin) return { success: false, error: 'PIN required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  if (!sheet) return { success: false, error: 'Users sheet not found. Please create it.' };

  var data = sheet.getDataRange().getValues();
  // Header row: pin, name, role
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(pin).trim()) {
      return {
        success: true,
        name: String(data[i][1]).trim(),
        role: String(data[i][2] || 'user').trim()
      };
    }
  }
  return { success: false, error: 'Invalid PIN' };
}

// ============ ENSURE SHEETS EXIST ============

function ensureSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetNames = Object.keys(SCHEMAS);

  for (var i = 0; i < sheetNames.length; i++) {
    var name = sheetNames[i];
    var headers = SCHEMAS[name];
    var sheet = ss.getSheetByName(name);

    if (!sheet) {
      // Sheet doesn't exist — create it with correct headers
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    } else {
      // Sheet exists — check if headers match the schema
      var existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var headersMatch = (existingHeaders.length === headers.length);
      if (headersMatch) {
        for (var h = 0; h < headers.length; h++) {
          if (String(existingHeaders[h]).trim() !== headers[h]) {
            headersMatch = false;
            break;
          }
        }
      }

      if (!headersMatch) {
        // Headers are wrong (old format). Save existing data rows, rewrite headers,
        // then put data back aligned to new schema as best we can.
        var lastRow = sheet.getLastRow();
        var lastCol = sheet.getLastColumn();
        var oldData = [];
        if (lastRow > 1 && lastCol > 0) {
          oldData = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
        }

        // Clear entire sheet
        sheet.clear();

        // Write correct headers
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
        sheet.setFrozenRows(1);

        // Try to re-map old data rows if they have the right number of columns
        // (i.e. data was written with new schema but headers were old)
        if (oldData.length > 0 && oldData[0].length === headers.length) {
          sheet.getRange(2, 1, oldData.length, headers.length).setValues(oldData);
        }
        // If column counts don't match, data is from old summary format — skip it.
        // The app will re-sync from localStorage on next save.
      }
    }
  }
  return ss;
}

// ============ LOAD ALL DATA ============

function loadAllData() {
  var ss = ensureSheets();
  var result = {
    ponds: [],
    stockings: [],
    mortalities: [],
    transactions: [],
    harvests: [],
    sales: []
  };

  var keys = Object.keys(KEY_TO_SHEET);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var sheetName = KEY_TO_SHEET[key];
    result[key] = readSheet(ss, sheetName);
  }

  // Check if old format exists and needs migration
  var oldSheet = ss.getSheetByName('ShaFatData');
  var needsMigration = false;
  if (oldSheet) {
    var oldData = oldSheet.getRange('A2').getValue();
    if (oldData && result.ponds.length === 0) {
      needsMigration = true;
    }
  }

  return { success: true, data: result, needsMigration: needsMigration };
}

function readSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // Only header row

  var headers = data[0];
  var rows = [];

  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      obj[headers[j]] = val === '' ? '' : val;
    }
    // Convert numeric fields
    if (obj.qty !== undefined && obj.qty !== '') obj.qty = Number(obj.qty);
    if (obj.amount !== undefined && obj.amount !== '') obj.amount = Number(obj.amount);
    if (obj.weight !== undefined && obj.weight !== '') obj.weight = Number(obj.weight);
    if (obj.costPer !== undefined && obj.costPer !== '') obj.costPer = Number(obj.costPer);
    if (obj.pricePerKg !== undefined && obj.pricePerKg !== '') obj.pricePerKg = Number(obj.pricePerKg);
    if (obj.total !== undefined && obj.total !== '') obj.total = Number(obj.total);

    if (obj.id) rows.push(obj); // Skip empty rows
  }
  return rows;
}

// ============ ADD RECORD ============

function addRecord(sheetName, jsonData) {
  if (!sheetName || !jsonData) return { success: false, error: 'Missing sheet or data' };
  if (!SCHEMAS[sheetName]) return { success: false, error: 'Unknown sheet: ' + sheetName };

  var ss = ensureSheets();
  var sheet = ss.getSheetByName(sheetName);
  var record = JSON.parse(jsonData);
  var headers = SCHEMAS[sheetName];

  var row = [];
  for (var i = 0; i < headers.length; i++) {
    row.push(record[headers[i]] !== undefined ? record[headers[i]] : '');
  }

  sheet.appendRow(row);
  return { success: true, id: record.id };
}

// ============ UPDATE RECORD ============

function updateRecord(sheetName, id, jsonData) {
  if (!sheetName || !id || !jsonData) return { success: false, error: 'Missing sheet, id, or data' };
  if (!SCHEMAS[sheetName]) return { success: false, error: 'Unknown sheet: ' + sheetName };

  var ss = ensureSheets();
  var sheet = ss.getSheetByName(sheetName);
  var record = JSON.parse(jsonData);
  var headers = SCHEMAS[sheetName];

  var rowIndex = findRowById(sheet, id);
  if (rowIndex === -1) return { success: false, error: 'Record not found: ' + id };

  var row = [];
  for (var i = 0; i < headers.length; i++) {
    row.push(record[headers[i]] !== undefined ? record[headers[i]] : '');
  }

  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
  return { success: true, id: id };
}

// ============ DELETE RECORD ============

function deleteRecord(sheetName, id) {
  if (!sheetName || !id) return { success: false, error: 'Missing sheet or id' };
  if (!SCHEMAS[sheetName]) return { success: false, error: 'Unknown sheet: ' + sheetName };

  var ss = ensureSheets();
  var sheet = ss.getSheetByName(sheetName);

  var rowIndex = findRowById(sheet, id);
  if (rowIndex === -1) return { success: false, error: 'Record not found: ' + id };

  sheet.deleteRow(rowIndex);
  return { success: true, id: id };
}

// ============ HELPERS ============

function findRowById(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      return i + 1; // Sheet rows are 1-indexed, +1 for header
    }
  }
  return -1;
}

// ============ FIX HEADERS ON EXISTING SHEETS ============

function fixAllHeaders() {
  var ss = ensureSheets(); // ensureSheets now auto-fixes mismatched headers
  var fixed = [];
  var sheetNames = Object.keys(SCHEMAS);
  for (var i = 0; i < sheetNames.length; i++) {
    var name = sheetNames[i];
    var sheet = ss.getSheetByName(name);
    if (sheet) {
      var currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      fixed.push(name + ': [' + currentHeaders.join(', ') + ']');
    }
  }
  return { success: true, message: 'Headers verified/fixed', sheets: fixed };
}

// ============ MIGRATION FROM OLD FORMAT ============

function migrateFromOldFormat() {
  var ss = ensureSheets();
  var oldSheet = ss.getSheetByName('ShaFatData');

  if (!oldSheet) return { success: true, message: 'No old data to migrate' };

  var jsonString = oldSheet.getRange('A2').getValue();
  if (!jsonString) return { success: true, message: 'No old data to migrate' };

  var oldData = JSON.parse(jsonString);
  var counts = {};

  var keys = Object.keys(KEY_TO_SHEET);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var sheetName = KEY_TO_SHEET[key];
    var records = oldData[key] || [];
    var sheet = ss.getSheetByName(sheetName);
    var headers = SCHEMAS[sheetName];

    counts[key] = records.length;

    for (var r = 0; r < records.length; r++) {
      var record = records[r];
      if (!record.createdBy) record.createdBy = 'migrated';

      var row = [];
      for (var h = 0; h < headers.length; h++) {
        row.push(record[headers[h]] !== undefined ? record[headers[h]] : '');
      }
      sheet.appendRow(row);
    }
  }

  // Rename old sheet
  oldSheet.setName('ShaFatData_backup');

  return { success: true, message: 'Migration complete', counts: counts };
}

// ============ BACKWARD COMPATIBLE FULL SAVE ============
// Kept for old app versions during transition

function saveFullData(jsonString) {
  if (!jsonString) return { success: false, error: 'No data' };

  var data = JSON.parse(jsonString);
  var ss = ensureSheets();

  // Write to individual sheets
  var keys = Object.keys(KEY_TO_SHEET);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var sheetName = KEY_TO_SHEET[key];
    var records = data[key] || [];
    var sheet = ss.getSheetByName(sheetName);
    var headers = SCHEMAS[sheetName];

    // Clear existing data (keep header)
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, headers.length).clear();
    }

    // Write all records
    for (var r = 0; r < records.length; r++) {
      var record = records[r];
      var row = [];
      for (var h = 0; h < headers.length; h++) {
        row.push(record[headers[h]] !== undefined ? record[headers[h]] : '');
      }
      sheet.appendRow(row);
    }
  }

  return { success: true, savedAt: new Date().toISOString() };
}
