/**
 * Ubiquiti UniFi Device Service
 *
 * Provides integration with Ubiquiti UniFi devices (UAP-AC-M-PRO, etc.)
 * for device testing, status checking, and configuration guidance.
 */

const axios = require("axios");
const https = require("https");

/**
 * Ubiquiti device categories
 */
const UBIQUITI_CATEGORIES = {
  unifi_ap: { name: "UniFi Access Points", icon: "wifi" },
  unifi_gateway: { name: "UniFi Gateways", icon: "shield" },
  unifi_switch: { name: "UniFi Switches", icon: "git-branch" },
  edge: { name: "EdgeMAX", icon: "server" },
  airmax: { name: "airMAX", icon: "radio" },
  uisp: { name: "UISP", icon: "radio-tower" },
};

/**
 * Ubiquiti device models and their capabilities - ALL BRANDS
 */
const UBIQUITI_MODELS = {
  // ============ UniFi Access Points - WiFi 6/6E ============
  "U6-PRO": {
    name: "UniFi 6 Pro",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "WiFi 6 high-performance indoor AP",
  },
  "U6-LITE": {
    name: "UniFi 6 Lite",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "WiFi 6 entry-level indoor AP",
  },
  "U6-LR": {
    name: "UniFi 6 Long-Range",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "WiFi 6 long-range indoor AP",
  },
  "U6-MESH": {
    name: "UniFi 6 Mesh",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, mesh: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "WiFi 6 outdoor mesh AP",
  },
  "U6-ENTERPRISE": {
    name: "UniFi 6 Enterprise",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, wifi6: true, wifi6e: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "WiFi 6E enterprise-grade AP",
  },
  "U6-EXTENDER": {
    name: "UniFi 6 Extender",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, mesh: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "WiFi 6 plug-in range extender",
  },
  "U6-IW": {
    name: "UniFi 6 In-Wall",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "WiFi 6 in-wall AP with switch ports",
  },

  // ============ UniFi Access Points - WiFi 5 (802.11ac) ============
  "UAP-AC-M-PRO": {
    name: "UniFi AP AC Mesh Pro",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, mesh: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Outdoor mesh AP with RADIUS and hotspot support",
  },
  "UAP-AC-M": {
    name: "UniFi AP AC Mesh",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, mesh: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Outdoor mesh AP",
  },
  "UAP-AC-PRO": {
    name: "UniFi AP AC Pro",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Indoor high-performance AP",
  },
  "UAP-AC-LITE": {
    name: "UniFi AP AC Lite",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Entry-level indoor AP",
  },
  "UAP-AC-LR": {
    name: "UniFi AP AC Long Range",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Long-range indoor AP",
  },
  "UAP-AC-HD": {
    name: "UniFi AP AC HD",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, mu_mimo: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "High-density indoor AP (Wave 2)",
  },
  "UAP-AC-SHD": {
    name: "UniFi AP AC SHD",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, security: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Secure high-density AP with RF scanning",
  },
  "UAP-AC-IW": {
    name: "UniFi AP AC In-Wall",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "In-wall AP with Ethernet ports",
  },
  "UAP-AC-IW-PRO": {
    name: "UniFi AP AC In-Wall Pro",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "High-performance in-wall AP",
  },
  "UAP-NANOHD": {
    name: "UniFi nanoHD",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, mu_mimo: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Compact Wave 2 AP",
  },
  "UAP-FLEXHD": {
    name: "UniFi FlexHD",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, bandSteering: true, mu_mimo: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Flexible indoor/outdoor AP",
  },
  "UAP-BEACONHD": {
    name: "UniFi BeaconHD",
    category: "unifi_ap",
    type: "access_point",
    supports: { radius: true, hotspot: true, guestPortal: true, mesh: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Plug-in mesh extender",
  },

  // ============ UniFi Gateways / Routers ============
  "UDM": {
    name: "UniFi Dream Machine",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true, builtInController: true, builtInAP: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "All-in-one router with built-in controller and AP",
  },
  "UDM-PRO": {
    name: "UniFi Dream Machine Pro",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true, builtInController: true, nvr: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Rackmount gateway with controller and NVR",
  },
  "UDM-SE": {
    name: "UniFi Dream Machine SE",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true, builtInController: true, poe: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Dream Machine Pro with PoE switch",
  },
  "UDR": {
    name: "UniFi Dream Router",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true, builtInController: true, builtInAP: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Compact all-in-one router with WiFi 6",
  },
  "UXG-PRO": {
    name: "UniFi Next-Gen Gateway Pro",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true, ips: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "High-performance security gateway",
  },
  "USG": {
    name: "UniFi Security Gateway",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Enterprise gateway/router",
  },
  "USG-PRO-4": {
    name: "UniFi Security Gateway Pro",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Rackmount enterprise gateway",
  },
  "USG-XG-8": {
    name: "UniFi Security Gateway XG",
    category: "unifi_gateway",
    type: "gateway",
    supports: { radius: true, hotspot: true, guestPortal: true, vlan: true, captivePortal: true, sfp_plus: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "10G enterprise gateway",
  },

  // ============ UniFi Switches (for VLAN support) ============
  "USW-LITE-8-POE": {
    name: "UniFi Switch Lite 8 PoE",
    category: "unifi_switch",
    type: "switch",
    supports: { vlan: true, poe: true, radius: false },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "8-port PoE switch for APs",
  },
  "USW-24-POE": {
    name: "UniFi Switch 24 PoE",
    category: "unifi_switch",
    type: "switch",
    supports: { vlan: true, poe: true, radius: false },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "24-port PoE switch",
  },
  "USW-PRO-24-POE": {
    name: "UniFi Switch Pro 24 PoE",
    category: "unifi_switch",
    type: "switch",
    supports: { vlan: true, poe: true, radius: true, dot1x: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "24-port Layer 3 PoE switch with 802.1X",
  },
  "USW-PRO-48-POE": {
    name: "UniFi Switch Pro 48 PoE",
    category: "unifi_switch",
    type: "switch",
    supports: { vlan: true, poe: true, radius: true, dot1x: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "48-port Layer 3 PoE switch with 802.1X",
  },

  // ============ EdgeMAX Routers ============
  "ER-X": {
    name: "EdgeRouter X",
    category: "edge",
    type: "router",
    supports: { radius: true, hotspot: true, vlan: true, captivePortal: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Compact router with EdgeOS",
    configMethod: "edgeos",
  },
  "ER-4": {
    name: "EdgeRouter 4",
    category: "edge",
    type: "router",
    supports: { radius: true, hotspot: true, vlan: true, captivePortal: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "4-port gigabit router",
    configMethod: "edgeos",
  },
  "ER-6P": {
    name: "EdgeRouter 6P",
    category: "edge",
    type: "router",
    supports: { radius: true, hotspot: true, vlan: true, captivePortal: true, poe: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "6-port PoE router",
    configMethod: "edgeos",
  },
  "ER-12": {
    name: "EdgeRouter 12",
    category: "edge",
    type: "router",
    supports: { radius: true, hotspot: true, vlan: true, captivePortal: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "10-port router with 2 SFP",
    configMethod: "edgeos",
  },

  // ============ airMAX (Outdoor PtP/PtMP) ============
  "LAP-120": {
    name: "LiteAP AC",
    category: "airmax",
    type: "access_point",
    supports: { radius: true, vlan: true, ptp: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "120° sector outdoor AP",
  },
  "LBE-5AC-GEN2": {
    name: "LiteBeam 5AC Gen2",
    category: "airmax",
    type: "bridge",
    supports: { radius: true, vlan: true, ptp: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Point-to-point bridge",
  },
  "NBE-5AC-GEN2": {
    name: "NanoBeam 5AC Gen2",
    category: "airmax",
    type: "bridge",
    supports: { radius: true, vlan: true, ptp: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Point-to-point bridge",
  },
  "PBE-5AC-GEN2": {
    name: "PowerBeam 5AC Gen2",
    category: "airmax",
    type: "bridge",
    supports: { radius: true, vlan: true, ptp: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Long-range point-to-point bridge",
  },
  "R5AC-LITE": {
    name: "Rocket 5AC Lite",
    category: "airmax",
    type: "base_station",
    supports: { radius: true, vlan: true, ptmp: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Base station for PtMP deployment",
  },

  // ============ UISP (ISP Equipment) ============
  "UISP-R": {
    name: "UISP Router",
    category: "uisp",
    type: "router",
    supports: { radius: true, hotspot: true, vlan: true, pppoe: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "ISP-grade router with PPPoE support",
  },
  "UISP-S": {
    name: "UISP Switch",
    category: "uisp",
    type: "switch",
    supports: { vlan: true, poe: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "ISP-grade PoE switch",
  },

  // ============ Generic/Other ============
  "OTHER": {
    name: "Other Ubiquiti Device",
    category: "unifi_ap",
    type: "unknown",
    supports: { radius: true, hotspot: true, guestPortal: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    notes: "Generic Ubiquiti device - check model documentation",
  },
};

/**
 * Create an axios instance for UniFi Controller API
 * @param {Object} config - Controller configuration
 * @returns {Object} Axios instance
 */
function createControllerClient(config) {
  const { controllerUrl, username, password } = config;

  // UniFi controllers use self-signed certs by default
  const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
  });

  return axios.create({
    baseURL: controllerUrl,
    httpsAgent,
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
    },
    withCredentials: true,
  });
}

/**
 * Test connection to UniFi Controller
 * @param {Object} config - Controller configuration
 * @returns {Promise<Object>} Connection test result
 */
async function testControllerConnection(config) {
  const { controllerUrl, username, password, site = "default" } = config;

  if (!controllerUrl || !username || !password) {
    return {
      success: false,
      message: "Controller URL, username, and password are required",
    };
  }

  try {
    const client = createControllerClient(config);

    // Login to controller
    const loginResponse = await client.post("/api/login", {
      username,
      password,
    });

    if (loginResponse.status !== 200) {
      return {
        success: false,
        message: "Login failed - check credentials",
      };
    }

    // Get cookies for subsequent requests
    const cookies = loginResponse.headers["set-cookie"];

    // Get site info
    const siteResponse = await client.get(`/api/s/${site}/stat/sysinfo`, {
      headers: {
        Cookie: cookies?.join("; "),
      },
    });

    const sysInfo = siteResponse.data?.data?.[0] || {};

    // Logout
    try {
      await client.post("/api/logout", {}, {
        headers: {
          Cookie: cookies?.join("; "),
        },
      });
    } catch (e) {
      // Ignore logout errors
    }

    return {
      success: true,
      message: "Connected to UniFi Controller",
      controllerVersion: sysInfo.version || "Unknown",
      siteName: site,
      timezone: sysInfo.timezone || "Unknown",
    };
  } catch (error) {
    console.error("UniFi Controller connection test failed:", error.message);

    if (error.code === "ECONNREFUSED") {
      return {
        success: false,
        message: "Connection refused - check controller URL and port",
      };
    }

    if (error.response?.status === 401) {
      return {
        success: false,
        message: "Authentication failed - check username and password",
      };
    }

    return {
      success: false,
      message: error.message || "Connection failed",
    };
  }
}

/**
 * Test if a Ubiquiti device is reachable (basic ping/HTTP check)
 * @param {string} ipAddress - Device IP address
 * @returns {Promise<Object>} Test result
 */
async function testDeviceConnection(ipAddress) {
  try {
    // Try to reach the device's management interface
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });

    const response = await axios.get(`https://${ipAddress}`, {
      httpsAgent,
      timeout: 5000,
      validateStatus: () => true, // Accept any status
    });

    // Ubiquiti devices typically return something on their management port
    if (response.status === 200 || response.status === 302 || response.status === 401) {
      return {
        success: true,
        message: "Device is reachable",
        httpStatus: response.status,
      };
    }

    return {
      success: false,
      message: `Device returned HTTP ${response.status}`,
    };
  } catch (error) {
    // Try HTTP as fallback
    try {
      const response = await axios.get(`http://${ipAddress}`, {
        timeout: 5000,
        validateStatus: () => true,
      });

      return {
        success: true,
        message: "Device is reachable (HTTP)",
        httpStatus: response.status,
      };
    } catch (httpError) {
      return {
        success: false,
        message: error.message || "Device unreachable",
      };
    }
  }
}

/**
 * Get RADIUS configuration instructions for a Ubiquiti device
 * @param {string} model - Device model
 * @param {Object} radiusConfig - RADIUS server configuration
 * @returns {Object} Configuration instructions
 */
function getRadiusConfigInstructions(model, radiusConfig) {
  const { radiusServer, radiusPort = 1812, radiusSecret, acctPort = 1813 } = radiusConfig;

  const modelInfo = UBIQUITI_MODELS[model] || UBIQUITI_MODELS["OTHER"];
  const configMethod = modelInfo.configMethod || "unifi-controller";

  const baseInstructions = {
    title: `RADIUS Configuration for ${modelInfo.name}`,
    model,
    category: modelInfo.category,
    configMethod,
    steps: [],
    notes: [],
    cliCommands: null,
  };

  // Different configuration based on device type
  if (configMethod === "edgeos" || modelInfo.category === "edge") {
    // EdgeRouter configuration via CLI
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access EdgeRouter",
        description: "SSH into your EdgeRouter or access via console",
      },
      {
        step: 2,
        title: "Enter Configuration Mode",
        description: "Enter configuration mode:",
        command: "configure",
      },
      {
        step: 3,
        title: "Configure RADIUS Server",
        description: "Add RADIUS server configuration:",
        command: `set system login radius-server ${radiusServer} secret '${radiusSecret}'
set system login radius-server ${radiusServer} port ${radiusPort}`,
      },
      {
        step: 4,
        title: "Configure Hotspot (Optional)",
        description: "For captive portal, configure hotspot:",
        command: `set service captive-portal interface eth1
set service captive-portal authentication mode radius
set service captive-portal authentication radius-server ${radiusServer}
set service captive-portal authentication radius-server secret '${radiusSecret}'`,
      },
      {
        step: 5,
        title: "Commit and Save",
        description: "Apply and save the configuration:",
        command: "commit\nsave",
      },
    ];

    baseInstructions.cliCommands = `configure
set system login radius-server ${radiusServer} secret '${radiusSecret}'
set system login radius-server ${radiusServer} port ${radiusPort}
set service captive-portal interface eth1
set service captive-portal authentication mode radius
set service captive-portal authentication radius-server ${radiusServer}
set service captive-portal authentication radius-server secret '${radiusSecret}'
commit
save
exit`;

  } else if (modelInfo.category === "airmax" || modelInfo.category === "uisp") {
    // airMAX/UISP configuration
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access Device Web UI",
        description: "Log into the device at its IP address",
      },
      {
        step: 2,
        title: "Navigate to Network Settings",
        description: "Go to Network or Services tab",
      },
      {
        step: 3,
        title: "Configure RADIUS",
        description: "Enable RADIUS authentication and enter:",
        config: {
          "RADIUS Server IP": radiusServer,
          "RADIUS Port": radiusPort,
          "Shared Secret": radiusSecret,
          "Accounting Port": acctPort,
        },
      },
      {
        step: 4,
        title: "Save Configuration",
        description: "Click Apply or Save to apply changes",
      },
    ];

  } else {
    // UniFi Controller configuration (default)
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access UniFi Controller",
        description: "Log into your UniFi Controller web interface (Network application)",
      },
      {
        step: 2,
        title: "Navigate to Profiles",
        description: "Go to Settings → Profiles → RADIUS",
      },
      {
        step: 3,
        title: "Create RADIUS Profile",
        description: "Click 'Create New RADIUS Profile' and enter:",
        config: {
          "Profile Name": "Bula WiFi RADIUS",
          "Authentication Servers": [{
            "IP Address": radiusServer,
            "Port": radiusPort,
            "Shared Secret": radiusSecret,
          }],
          "Accounting Servers": [{
            "IP Address": radiusServer,
            "Port": acctPort,
            "Shared Secret": radiusSecret,
          }],
        },
      },
      {
        step: 4,
        title: "Create WiFi Network",
        description: "Go to Settings → WiFi → Create New WiFi Network:",
        config: {
          "Network Name (SSID)": "Your WiFi Name",
          "Security Protocol": "WPA2 Enterprise",
          "RADIUS Profile": "Bula WiFi RADIUS",
        },
      },
      {
        step: 5,
        title: "Apply Changes",
        description: "Click 'Apply Changes' to provision settings to access points",
      },
    ];

    // Add guest portal for devices that support it
    if (modelInfo.supports?.hotspot || modelInfo.supports?.guestPortal) {
      baseInstructions.steps.push({
        step: 6,
        title: "Optional: Configure Guest Hotspot",
        description: "For captive portal, go to Settings → Hotspot and configure:",
        config: {
          "Enable Hotspot": true,
          "Landing Page": "External Portal",
          "Portal URL": "https://your-portal-domain.com/portal",
          "Redirect URL": "https://your-portal-domain.com/portal",
          "Authentication": "RADIUS",
          "RADIUS Profile": "Bula WiFi RADIUS",
        },
      });

      baseInstructions.steps.push({
        step: 7,
        title: "Configure Pre-Authorization Access",
        description: "Add allowed hosts before authentication (walled garden):",
        config: {
          "Pre-Authorization Access": [
            "your-portal-domain.com",
            "*.flutterwave.com",
            "*.yo.co.ug",
          ],
        },
      });
    }
  }

  baseInstructions.notes = [
    "Ensure your RADIUS server is accessible from the Ubiquiti device network",
    "The RADIUS secret must match exactly on both device and server",
    "Accounting enables session tracking and data usage monitoring",
    modelInfo.notes,
  ];

  // Add category-specific notes
  if (modelInfo.category === "unifi_switch" && modelInfo.supports?.dot1x) {
    baseInstructions.notes.push("This switch supports 802.1X port-based authentication");
  }

  if (modelInfo.supports?.builtInController) {
    baseInstructions.notes.push("This device has a built-in controller - no separate controller needed");
  }

  return baseInstructions;
}

/**
 * Get hotspot/captive portal configuration for Ubiquiti
 * @param {string} model - Device model
 * @param {Object} portalConfig - Portal configuration
 * @returns {Object} Hotspot configuration
 */
function getHotspotConfigInstructions(model, portalConfig) {
  const { portalUrl, redirectUrl, radiusServer, radiusSecret } = portalConfig;

  const modelInfo = UBIQUITI_MODELS[model] || UBIQUITI_MODELS["OTHER"];

  return {
    title: `Hotspot Configuration for ${modelInfo.name}`,
    model,
    steps: [
      {
        step: 1,
        title: "Enable Guest Control",
        description: "Go to Settings → Guest Control → Enable Guest Portal",
      },
      {
        step: 2,
        title: "Configure Portal Type",
        description: "Set portal type:",
        config: {
          "Portal Type": "External Portal",
          "Custom Portal URL": portalUrl,
          "Redirect URL": redirectUrl || portalUrl,
        },
      },
      {
        step: 3,
        title: "Configure Authentication",
        description: "Set authentication method:",
        config: {
          Authentication: "RADIUS",
          "RADIUS Server": radiusServer,
          "Shared Secret": radiusSecret,
        },
      },
      {
        step: 4,
        title: "Set Pre-Authorization Access",
        description: "Add allowed hosts before authentication (walled garden):",
        config: {
          "Pre-Auth Allowed Hosts": [
            portalUrl.replace(/^https?:\/\//, "").split("/")[0],
            "*.flutterwave.com",
            "*.yo.co.ug",
          ].join(", "),
        },
      },
      {
        step: 5,
        title: "Configure Landing Page",
        description: "Optional: Set a custom landing page after authentication",
      },
    ],
    notes: [
      "The portal URL must be accessible from the client network",
      "Add payment gateway domains to pre-auth allowed hosts",
      "Test the portal flow from a client device after configuration",
    ],
  };
}

/**
 * Validate Ubiquiti device configuration
 * @param {Object} config - Device configuration
 * @returns {Object} Validation result
 */
function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.ip_address) {
    errors.push("IP address is required");
  } else if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(config.ip_address)) {
    errors.push("Invalid IP address format");
  }

  if (!config.secret || config.secret.length < 8) {
    errors.push("RADIUS secret must be at least 8 characters");
  }

  if (config.model && !UBIQUITI_MODELS[config.model]) {
    warnings.push(`Unknown model "${config.model}" - using generic settings`);
  }

  if (config.controllerUrl) {
    try {
      new URL(config.controllerUrl);
    } catch (e) {
      errors.push("Invalid controller URL format");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  UBIQUITI_CATEGORIES,
  UBIQUITI_MODELS,
  testControllerConnection,
  testDeviceConnection,
  getRadiusConfigInstructions,
  getHotspotConfigInstructions,
  validateConfig,
};
