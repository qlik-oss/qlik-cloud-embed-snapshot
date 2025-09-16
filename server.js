// - M2M auth to Qlik via a documented "custom" auth module
// - Lists "chart-monitoring" tasks
// - Downloads snapshot artifacts into /public/snapshots/<id>
// - Returns [{ id, name }] for the frontend

import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { items as qlikItems, sharingTasks as qlikSharing } from "@qlik/api";
import { setDefaultHostConfig } from "@qlik/api/auth";

// Validate required environment variables
const requiredEnvVars = [
  "QLIK_TENANT_URL",
  "QLIK_M2M_CLIENT_ID",
  "QLIK_M2M_CLIENT_SECRET",
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    console.error(`Please set ${envVar} in your .env file or environment.`);
    process.exit(1);
  }
}

const app = express();
app.use(express.static(path.resolve("."), { extensions: ["html"] }));
app.use("/public", express.static(path.resolve("public")));

const hostConfig = {
  host: process.env.QLIK_TENANT_URL,
  authType: "OAuth2",
  clientId: process.env.QLIK_M2M_CLIENT_ID,
  clientSecret: process.env.QLIK_M2M_CLIENT_SECRET,
  scope: "user_default",
};

// Set a default host so calls don't need a hostConfig each time
setDefaultHostConfig(hostConfig);

// --- GET /get-snapshots ---
app.get("/get-snapshots", async (_req, res) => {
  try {
    // 1) List chart-monitoring tasks
    const items = await qlikItems.getItems({
      resourceType: "sharingservicetask",
      resourceSubType: "chart-monitoring",
    });

    // 2) Fetch full task details (id, name, latestExecutionFilesURL, ...)
    // This is needed to keep the task active
    const tasks = [];
    for (const it of items.data.data) {
      const t = await qlikSharing.getSharingTask(it.resourceId, {
        isViewChart: true,
      });
      console.log(`Fetched task ${t.data.id} (${t.data.name})`);
      tasks.push(t.data);
    }

    // 3) Save artifacts to /public/snapshots/<id> with correct extensions
    await saveSnapshots(tasks);

    // 4) Read the enhanced metadata from saved files and return for the UI
    const enhancedTasks = [];
    const snapshotsDir = path.resolve("public", "snapshots");
    const processingErrors = [];

    for (const task of tasks) {
      const metadataPath = path.join(snapshotsDir, task.id, "metadata.json");
      try {
        const metadataContent = await fs.readFile(metadataPath, "utf8");
        const metadata = JSON.parse(metadataContent);

        // Only include complete snapshots
        enhancedTasks.push({
          id: metadata.id,
          name: metadata.name,
          visualization: metadata.visualization || "unknown",
          imageAvailable: metadata.imageAvailable || false,
          snapshotAvailable: metadata.snapshotAvailable || false,
          displayMode: metadata.displayMode || "image",
        });
      } catch (err) {
        // If metadata doesn't exist, the snapshot was incomplete and skipped
        const errorMsg = `Snapshot for task ${task.name} (${task.id}) was incomplete and not saved`;
        console.log(`   ${errorMsg}`);
        processingErrors.push(errorMsg);
        continue;
      }
    }

    // Log summary of processing results
    console.log(
      `Successfully processed ${enhancedTasks.length} complete snapshots`
    );
    if (processingErrors.length > 0) {
      console.log(
        `⚠️ ${processingErrors.length} snapshots were incomplete and skipped`
      );
    }

    res.json(enhancedTasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Unexpected error" });
  }
});

// --- GET /get-local-snapshots ---
app.get("/get-local-snapshots", async (_req, res) => {
  try {
    const snapshotsDir = path.resolve("public", "snapshots");

    // Check if snapshots directory exists
    try {
      await fs.access(snapshotsDir);
    } catch {
      // Directory doesn't exist, return empty array
      return res.json([]);
    }

    // Read all subdirectories in snapshots folder
    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
    const snapshotFolders = entries.filter((entry) => entry.isDirectory());

    const snapshots = [];

    for (const folder of snapshotFolders) {
      const metadataPath = path.join(
        snapshotsDir,
        folder.name,
        "metadata.json"
      );

      try {
        // Read metadata file
        const metadataContent = await fs.readFile(metadataPath, "utf8");
        const metadata = JSON.parse(metadataContent);

        // Extract all relevant fields from metadata
        snapshots.push({
          id: metadata.id || folder.name,
          name: metadata.name || `Snapshot ${folder.name}`,
          visualization: metadata.visualization || "unknown",
          imageAvailable: metadata.imageAvailable || false,
          snapshotAvailable: metadata.snapshotAvailable || false,
          displayMode: metadata.displayMode || "image",
        });
      } catch (err) {
        console.log(`Could not read metadata for ${folder.name}:`, err.message);
        // Skip snapshots where metadata cannot be read
        continue;
      }
    }

    console.log(`Found ${snapshots.length} local snapshots`);
    res.json(snapshots);
  } catch (err) {
    console.error("Error reading local snapshots:", err);
    res.status(500).json({ error: err.message || "Unexpected error" });
  }
});

// Define supported chart types for interactive rendering
const SUPPORTED_CHARTS = [
  "barchart",
  "piechart",
  "linechart",
  "mekkochart",
  "qlik-funnel-chart-ext",
  "qlik-sankey-chart-ext",
  "kpi",
  "bulletchart",
  "sn-org-chart",
  "combochart",
  "scatterplot",
  "histogram",
  "waterfallchart",
  "gauge",
  "childObject",
];

// --- Save snapshot artifacts and create enhanced metadata ---
async function saveSnapshots(tasks) {
  const root = path.resolve("public", "snapshots");
  await fs.mkdir(root, { recursive: true });

  for (const task of tasks) {
    const dir = path.join(root, task.id);
    await fs.mkdir(dir, { recursive: true });

    // Track what files were successfully saved
    let snapshotData = null;
    let imageSmallSaved = false;
    let imageLargeSaved = false;
    let snapshotSaved = false;
    let hasFailures = false;

    // Assume execution ID is "latest" and download specific file formats
    const executionId = "latest";
    const fileFormats = ["snapshot", "image-small", "image-large"];

    // Download each expected file format
    for (const fileAlias of fileFormats) {
      try {
        console.log(`Attempting to download ${fileAlias} for task ${task.id}`);
        const fileResponse = await qlikSharing.getSharingTaskExecutionFile(
          task.id,
          executionId,
          fileAlias,
          { status: "successful" }
        );
        if (fileResponse.status = 200) {
          const contentType = (
            fileResponse.headers.get("content-type") || ""
          ).toLowerCase();

          let outName;
          if (contentType.includes("application/json")) {
            // Handle JSON data - data is directly available
            const json = fileResponse.data;
            outName = `${fileAlias}.json`;
            console.log(`   Saving JSON file: ${path.join(dir, outName)}`);
            await fs.writeFile(
              path.join(dir, outName),
              JSON.stringify(json, null, 2),
              "utf8"
            );

            // Store snapshot data for metadata
            if (fileAlias === "snapshot") {
              snapshotData = json;
              snapshotSaved = true;
            }
          } else {
            // Handle binary data (images, etc.) - data is directly available
            let buf;
            if (fileResponse.data instanceof Blob) {
              const arrayBuffer = await fileResponse.data.arrayBuffer();
              buf = Buffer.from(arrayBuffer);
            } else if (Buffer.isBuffer(fileResponse.data)) {
              buf = fileResponse.data;
            } else {
              buf = Buffer.from(fileResponse.data);
            }

            if (contentType.includes("image/png")) {
              outName = `${fileAlias}.png`;
            } else {
              outName = fileAlias;
            }
            console.log(`   Saving binary file: ${path.join(dir, outName)}`);
            await fs.writeFile(path.join(dir, outName), buf);

            // Track image saves
            if (fileAlias === "image-small") {
              imageSmallSaved = true;
            } else if (fileAlias === "image-large") {
              imageLargeSaved = true;
            }
          }
        } else {
          // Non-success HTTP status is a failure
          console.error(
            `   Failed to download ${fileAlias} for task ${task.id}: HTTP ${fileResponse.status}`
          );
          hasFailures = true;
          break;
        }
      } catch (fileErr) {
        // Any error (including 404) is a failure
        console.error(
          `   Failed to download ${fileAlias} for task ${task.id}:`,
          fileErr.message || fileErr
        );
        hasFailures = true;
        break;
      }
    }

    // If ANY file failed, clean up and skip this task entirely
    if (hasFailures || !imageSmallSaved || !imageLargeSaved || !snapshotSaved) {
      console.warn(
        `   ❌ Task ${task.name} (${task.id}) incomplete - cleaning up`
      );
      try {
        await fs.rm(dir, { recursive: true });
        console.log(
          `   Cleaned up incomplete snapshot directory for task ${task.id}`
        );
      } catch (cleanupErr) {
        console.warn(
          `   ⚠️ Failed to cleanup directory for task ${task.id}:`,
          cleanupErr.message
        );
      }
      continue; // Skip to next task
    }

    // Determine visualization type
    let visualization = "unknown";
    if (snapshotData && snapshotData.visualization) {
      visualization = snapshotData.visualization;
    }

    // Determine display mode based on whether visualization is supported
    const displayMode = SUPPORTED_CHARTS.includes(visualization)
      ? "snapshot"
      : "image";

    // All files are guaranteed to be present at this point
    const enhancedMetadata = {
      ...task,
      visualization,
      imageAvailable: true,
      snapshotAvailable: true,
      displayMode,
      lastUpdated: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(dir, "metadata.json"),
      JSON.stringify(enhancedMetadata, null, 2),
      "utf8"
    );
    console.log(`   Successfully saved complete snapshot for task ${task.id}`);
  }
}

// --- Start server ---
const PORT = process.env.PORT || 3000;
try {
  const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `❌ Port ${PORT} is already in use. Please free the port or set a different PORT environment variable.`
      );
    } else {
      console.error(`❌ Server error:`, err);
    }
    process.exit(1);
  });
} catch (err) {
  console.error(`❌ Failed to start server:`, err);
  process.exit(1);
}
