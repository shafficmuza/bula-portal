/**
 * Cisco Device Service
 *
 * Provides integration with Cisco devices (Aironet, Catalyst, Meraki, ISR, etc.)
 * for device testing, status checking, and configuration guidance.
 */

const axios = require("axios");

/**
 * Cisco device categories
 */
const CISCO_CATEGORIES = {
  wireless_ap: { name: "Wireless Access Points", icon: "wifi" },
  wlc: { name: "Wireless LAN Controllers", icon: "server" },
  meraki: { name: "Meraki Cloud-Managed", icon: "cloud" },
  router: { name: "Routers", icon: "router" },
  switch: { name: "Switches", icon: "git-branch" },
  firewall: { name: "Firewalls/ASA", icon: "shield" },
};

/**
 * Cisco device models and their capabilities - ALL MAJOR PRODUCTS
 */
const CISCO_MODELS = {
  // ============ Cisco Wireless Access Points (Standalone/Mobility Express) ============
  "AIR-AP1832I": {
    name: "Aironet 1832i",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, vlan: true, localAuth: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios",
    notes: "802.11ac Wave 1 indoor AP, supports Mobility Express",
  },
  "AIR-AP1852I": {
    name: "Aironet 1852i",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, vlan: true, localAuth: true, wave2: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios",
    notes: "802.11ac Wave 2 indoor AP with MU-MIMO",
  },
  "AIR-AP2802I": {
    name: "Aironet 2802i",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, vlan: true, localAuth: true, wave2: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios",
    notes: "High-performance 802.11ac Wave 2 AP",
  },
  "AIR-AP3802I": {
    name: "Aironet 3802i",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, vlan: true, localAuth: true, wave2: true, moduleDual: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios",
    notes: "Enterprise 802.11ac Wave 2 with flexible radio",
  },
  "AIR-AP4800": {
    name: "Aironet 4800",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, vlan: true, wave2: true, multigigabit: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios",
    notes: "Premium 802.11ac Wave 2 with multigigabit",
  },
  "C9105AXI": {
    name: "Catalyst 9105AXI",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa3: true, wpa2_enterprise: true, vlan: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "WiFi 6 entry-level indoor AP",
  },
  "C9115AXI": {
    name: "Catalyst 9115AXI",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa3: true, wpa2_enterprise: true, vlan: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "WiFi 6 mid-range indoor AP",
  },
  "C9120AXI": {
    name: "Catalyst 9120AXI",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa3: true, wpa2_enterprise: true, vlan: true, wifi6: true, iot: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "WiFi 6 with IoT radio capabilities",
  },
  "C9130AXI": {
    name: "Catalyst 9130AXI",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa3: true, wpa2_enterprise: true, vlan: true, wifi6: true, triRadio: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "WiFi 6 enterprise tri-radio AP",
  },
  "C9136I": {
    name: "Catalyst 9136I",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa3: true, wpa2_enterprise: true, vlan: true, wifi6e: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "WiFi 6E indoor AP with 6GHz support",
  },
  "C9166I": {
    name: "Catalyst 9166I",
    category: "wireless_ap",
    type: "access_point",
    supports: { radius: true, wpa3: true, wpa2_enterprise: true, vlan: true, wifi6e: true, triRadio: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "WiFi 6E flagship tri-radio AP",
  },

  // ============ Cisco Wireless LAN Controllers ============
  "WLC-3504": {
    name: "3504 Wireless Controller",
    category: "wlc",
    type: "controller",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, maxAPs: 150 },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "aireos",
    notes: "Entry-level WLC for up to 150 APs",
  },
  "WLC-5520": {
    name: "5520 Wireless Controller",
    category: "wlc",
    type: "controller",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, maxAPs: 1500, ha: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "aireos",
    notes: "Mid-range WLC with HA support",
  },
  "WLC-8540": {
    name: "8540 Wireless Controller",
    category: "wlc",
    type: "controller",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, maxAPs: 6000, ha: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "aireos",
    notes: "High-capacity enterprise WLC",
  },
  "C9800-40": {
    name: "Catalyst 9800-40",
    category: "wlc",
    type: "controller",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, maxAPs: 2000, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Next-gen IOS-XE based WLC",
  },
  "C9800-80": {
    name: "Catalyst 9800-80",
    category: "wlc",
    type: "controller",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, maxAPs: 6000, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "High-capacity IOS-XE WLC",
  },
  "C9800-CL": {
    name: "Catalyst 9800-CL (Virtual)",
    category: "wlc",
    type: "controller",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, virtual: true, wifi6: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Virtual WLC for cloud/VM deployment",
  },
  "EWC": {
    name: "Embedded Wireless Controller",
    category: "wlc",
    type: "controller",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, embedded: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "WLC embedded in Catalyst 9100 APs",
  },

  // ============ Cisco Meraki (Cloud-Managed) ============
  "MR36": {
    name: "Meraki MR36",
    category: "meraki",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, wifi6: true, cloud: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "WiFi 6 cloud-managed indoor AP",
  },
  "MR44": {
    name: "Meraki MR44",
    category: "meraki",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, wifi6: true, cloud: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "WiFi 6 high-density indoor AP",
  },
  "MR46": {
    name: "Meraki MR46",
    category: "meraki",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, wifi6: true, cloud: true, triRadio: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "WiFi 6 enterprise tri-radio AP",
  },
  "MR56": {
    name: "Meraki MR56",
    category: "meraki",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, wifi6: true, cloud: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "WiFi 6 flagship indoor AP",
  },
  "MR76": {
    name: "Meraki MR76",
    category: "meraki",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, wifi6: true, cloud: true, outdoor: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "WiFi 6 outdoor rugged AP",
  },
  "MR86": {
    name: "Meraki MR86",
    category: "meraki",
    type: "access_point",
    supports: { radius: true, wpa2_enterprise: true, wpa3: true, guestPortal: true, vlan: true, wifi6: true, cloud: true, outdoor: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "WiFi 6 premium outdoor AP",
  },
  "MX67": {
    name: "Meraki MX67",
    category: "meraki",
    type: "gateway",
    supports: { radius: true, vlan: true, vpn: true, firewall: true, cloud: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "Cloud-managed security appliance",
  },
  "MX68": {
    name: "Meraki MX68",
    category: "meraki",
    type: "gateway",
    supports: { radius: true, vlan: true, vpn: true, firewall: true, cloud: true, wlan: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "Security appliance with built-in WiFi",
  },
  "MS120": {
    name: "Meraki MS120",
    category: "meraki",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, cloud: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "Cloud-managed access switch with 802.1X",
  },
  "MS225": {
    name: "Meraki MS225",
    category: "meraki",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, cloud: true, stacking: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "meraki-dashboard",
    notes: "Cloud-managed stackable switch",
  },

  // ============ Cisco Routers ============
  "ISR-1100": {
    name: "ISR 1100 Series",
    category: "router",
    type: "router",
    supports: { radius: true, vlan: true, vpn: true, nat: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Entry-level branch router",
  },
  "ISR-4321": {
    name: "ISR 4321",
    category: "router",
    type: "router",
    supports: { radius: true, vlan: true, vpn: true, nat: true, appx: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Mid-range integrated services router",
  },
  "ISR-4331": {
    name: "ISR 4331",
    category: "router",
    type: "router",
    supports: { radius: true, vlan: true, vpn: true, nat: true, appx: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Branch router with modular services",
  },
  "ISR-4351": {
    name: "ISR 4351",
    category: "router",
    type: "router",
    supports: { radius: true, vlan: true, vpn: true, nat: true, appx: true, highPerf: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "High-performance branch router",
  },
  "ISR-4461": {
    name: "ISR 4461",
    category: "router",
    type: "router",
    supports: { radius: true, vlan: true, vpn: true, nat: true, appx: true, sdwan: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Enterprise router with SD-WAN",
  },
  "C8200": {
    name: "Catalyst 8200 Edge",
    category: "router",
    type: "router",
    supports: { radius: true, vlan: true, vpn: true, sdwan: true, cloud: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Next-gen edge router for SD-WAN",
  },
  "C8300": {
    name: "Catalyst 8300 Edge",
    category: "router",
    type: "router",
    supports: { radius: true, vlan: true, vpn: true, sdwan: true, modular: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Modular edge platform",
  },

  // ============ Cisco Switches ============
  "C9200": {
    name: "Catalyst 9200",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, poe: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Entry-level access switch with 802.1X",
  },
  "C9300": {
    name: "Catalyst 9300",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, poe: true, stacking: true, upoe: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Stackable access switch with UPOE+",
  },
  "C9400": {
    name: "Catalyst 9400",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, poe: true, modular: true, sso: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Modular enterprise switch",
  },
  "C9500": {
    name: "Catalyst 9500",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, highPerf: true, sfp28: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "High-performance aggregation switch",
  },
  "C3650": {
    name: "Catalyst 3650",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, poe: true, stacking: true, wlc: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Converged access switch with embedded WLC",
  },
  "C3850": {
    name: "Catalyst 3850",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, poe: true, stacking: true, wlc: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios-xe",
    notes: "Converged access with wireless controller",
  },
  "CBS250": {
    name: "CBS250 Smart Switch",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, poe: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "web",
    notes: "SMB smart switch with 802.1X",
  },
  "CBS350": {
    name: "CBS350 Managed Switch",
    category: "switch",
    type: "switch",
    supports: { vlan: true, dot1x: true, radius: true, poe: true, stacking: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "web",
    notes: "SMB managed switch with advanced features",
  },

  // ============ Cisco Firewalls/ASA ============
  "ASA-5506": {
    name: "ASA 5506-X",
    category: "firewall",
    type: "firewall",
    supports: { radius: true, vpn: true, firewall: true, ips: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "asa",
    notes: "Entry-level firewall with FirePOWER",
  },
  "ASA-5508": {
    name: "ASA 5508-X",
    category: "firewall",
    type: "firewall",
    supports: { radius: true, vpn: true, firewall: true, ips: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "asa",
    notes: "Mid-range firewall with FirePOWER",
  },
  "ASA-5516": {
    name: "ASA 5516-X",
    category: "firewall",
    type: "firewall",
    supports: { radius: true, vpn: true, firewall: true, ips: true, ha: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "asa",
    notes: "Enterprise firewall with HA support",
  },
  "FPR-1010": {
    name: "Firepower 1010",
    category: "firewall",
    type: "firewall",
    supports: { radius: true, vpn: true, firewall: true, ips: true, ngfw: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "fmc",
    notes: "Next-gen firewall for small business",
  },
  "FPR-2110": {
    name: "Firepower 2110",
    category: "firewall",
    type: "firewall",
    supports: { radius: true, vpn: true, firewall: true, ips: true, ngfw: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "fmc",
    notes: "Next-gen firewall for branch/edge",
  },
  "FPR-4110": {
    name: "Firepower 4110",
    category: "firewall",
    type: "firewall",
    supports: { radius: true, vpn: true, firewall: true, ips: true, ngfw: true, clustering: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "fmc",
    notes: "High-performance enterprise NGFW",
  },

  // ============ Generic/Other ============
  "OTHER": {
    name: "Other Cisco Device",
    category: "wireless_ap",
    type: "unknown",
    supports: { radius: true },
    defaultPorts: { radius: 1812, radiusAcct: 1813 },
    configMethod: "ios",
    notes: "Generic Cisco device - check model documentation",
  },
};

/**
 * Get RADIUS configuration instructions for a Cisco device
 * @param {string} model - Device model
 * @param {Object} radiusConfig - RADIUS server configuration
 * @returns {Object} Configuration instructions
 */
function getRadiusConfigInstructions(model, radiusConfig) {
  const { radiusServer, radiusPort = 1812, radiusSecret, acctPort = 1813 } = radiusConfig;

  const modelInfo = CISCO_MODELS[model] || CISCO_MODELS["OTHER"];
  const configMethod = modelInfo.configMethod || "ios";

  const baseInstructions = {
    title: `RADIUS Configuration for ${modelInfo.name}`,
    model,
    category: modelInfo.category,
    configMethod,
    steps: [],
    notes: [],
    cliCommands: null,
  };

  // Configuration based on device type
  if (configMethod === "meraki-dashboard") {
    // Meraki Dashboard configuration
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access Meraki Dashboard",
        description: "Log into dashboard.meraki.com",
      },
      {
        step: 2,
        title: "Navigate to RADIUS Settings",
        description: "Go to Wireless → Configure → Access control",
      },
      {
        step: 3,
        title: "Configure RADIUS Server",
        description: "Under RADIUS servers, click 'Add a server' and enter:",
        config: {
          "Host": radiusServer,
          "Port": radiusPort,
          "Secret": radiusSecret,
        },
      },
      {
        step: 4,
        title: "Configure RADIUS Accounting",
        description: "Enable RADIUS accounting:",
        config: {
          "RADIUS accounting": "Enabled",
          "Accounting server": radiusServer,
          "Accounting port": acctPort,
          "Accounting secret": radiusSecret,
        },
      },
      {
        step: 5,
        title: "Set Authentication Type",
        description: "Configure the SSID security:",
        config: {
          "Security mode": "WPA2-Enterprise with my RADIUS server",
          "WPA encryption mode": "WPA2 only with AES",
        },
      },
      {
        step: 6,
        title: "Save Changes",
        description: "Click 'Save changes' - settings propagate automatically",
      },
    ];

    // Add splash page for guest portal
    if (modelInfo.supports?.guestPortal) {
      baseInstructions.steps.push({
        step: 7,
        title: "Optional: Configure Splash Page",
        description: "For captive portal, go to Wireless → Configure → Splash page:",
        config: {
          "Splash page": "Click-through or Sign-on with RADIUS",
          "Custom splash URL": "https://your-portal-domain.com/portal",
          "Walled garden": "your-portal-domain.com, *.flutterwave.com, *.yo.co.ug",
        },
      });
    }

  } else if (configMethod === "aireos") {
    // Cisco WLC (AireOS) configuration
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access WLC GUI",
        description: "Log into the Wireless LAN Controller web interface",
      },
      {
        step: 2,
        title: "Add RADIUS Server",
        description: "Go to SECURITY → AAA → RADIUS → Authentication and click 'New':",
        config: {
          "Server Address": radiusServer,
          "Port Number": radiusPort,
          "Shared Secret": radiusSecret,
          "Server Status": "Enabled",
        },
      },
      {
        step: 3,
        title: "Add RADIUS Accounting",
        description: "Go to SECURITY → AAA → RADIUS → Accounting and click 'New':",
        config: {
          "Server Address": radiusServer,
          "Port Number": acctPort,
          "Shared Secret": radiusSecret,
          "Server Status": "Enabled",
        },
      },
      {
        step: 4,
        title: "Configure WLAN Security",
        description: "Go to WLANs → [Your WLAN] → Security → AAA Servers:",
        config: {
          "Authentication Servers": `${radiusServer}`,
          "Accounting Servers": `${radiusServer}`,
        },
      },
      {
        step: 5,
        title: "Set Layer 2 Security",
        description: "Under Security → Layer 2:",
        config: {
          "Layer 2 Security": "WPA+WPA2",
          "WPA2 Policy": "Enabled",
          "WPA2 Encryption": "AES",
          "Authentication Key Management": "802.1X",
        },
      },
    ];

    baseInstructions.cliCommands = `# WLC CLI Commands
config radius auth add 1 ${radiusServer} ${radiusPort} ascii ${radiusSecret}
config radius acct add 1 ${radiusServer} ${acctPort} ascii ${radiusSecret}
config wlan radius_server auth add <wlan-id> 1
config wlan radius_server acct add <wlan-id> 1
config wlan security wpa akm 802.1x enable <wlan-id>`;

  } else if (configMethod === "ios-xe" || configMethod === "ios") {
    // Cisco IOS/IOS-XE configuration
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access Device CLI",
        description: "SSH or console into the device and enter privileged EXEC mode",
        command: "enable",
      },
      {
        step: 2,
        title: "Enter Global Configuration",
        description: "Enter configuration mode",
        command: "configure terminal",
      },
      {
        step: 3,
        title: "Enable AAA",
        description: "Enable AAA new-model",
        command: "aaa new-model",
      },
      {
        step: 4,
        title: "Configure RADIUS Server",
        description: "Add RADIUS server configuration",
        command: `radius server BULA-RADIUS
  address ipv4 ${radiusServer} auth-port ${radiusPort} acct-port ${acctPort}
  key ${radiusSecret}`,
      },
      {
        step: 5,
        title: "Create Server Group",
        description: "Create a RADIUS server group",
        command: `aaa group server radius BULA-GROUP
  server name BULA-RADIUS`,
      },
      {
        step: 6,
        title: "Configure Authentication",
        description: "Set up authentication method",
        command: `aaa authentication dot1x default group BULA-GROUP
aaa authorization network default group BULA-GROUP
aaa accounting dot1x default start-stop group BULA-GROUP`,
      },
      {
        step: 7,
        title: "Enable 802.1X Globally",
        description: "Enable 802.1X system authentication",
        command: "dot1x system-auth-control",
      },
      {
        step: 8,
        title: "Save Configuration",
        description: "Save the running configuration",
        command: "end\nwrite memory",
      },
    ];

    baseInstructions.cliCommands = `enable
configure terminal
!
! Enable AAA
aaa new-model
!
! Configure RADIUS server
radius server BULA-RADIUS
  address ipv4 ${radiusServer} auth-port ${radiusPort} acct-port ${acctPort}
  key ${radiusSecret}
!
! Create server group
aaa group server radius BULA-GROUP
  server name BULA-RADIUS
!
! Configure authentication methods
aaa authentication dot1x default group BULA-GROUP
aaa authorization network default group BULA-GROUP
aaa accounting dot1x default start-stop group BULA-GROUP
!
! Enable 802.1X
dot1x system-auth-control
!
end
write memory`;

    // Add wireless-specific config for APs
    if (modelInfo.category === "wireless_ap" || modelInfo.category === "wlc") {
      baseInstructions.cliCommands += `

! Wireless SSID Configuration (for APs/WLC)
wlan BULA-WIFI 1 BULA-WIFI
  security wpa wpa2
  security wpa akm dot1x
  security dot1x authentication-list default
  no shutdown`;
    }

  } else if (configMethod === "asa") {
    // Cisco ASA configuration
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access ASA CLI",
        description: "SSH or console into the ASA",
      },
      {
        step: 2,
        title: "Enter Configuration Mode",
        description: "Enter global configuration",
        command: "configure terminal",
      },
      {
        step: 3,
        title: "Configure AAA Server Group",
        description: "Create RADIUS server group",
        command: `aaa-server BULA-RADIUS protocol radius
aaa-server BULA-RADIUS (inside) host ${radiusServer}
  key ${radiusSecret}
  authentication-port ${radiusPort}
  accounting-port ${acctPort}`,
      },
      {
        step: 4,
        title: "Configure Authentication",
        description: "Set up authentication",
        command: `aaa authentication match BULA-AUTH inside BULA-RADIUS
aaa accounting match BULA-ACCT inside BULA-RADIUS`,
      },
      {
        step: 5,
        title: "Save Configuration",
        description: "Save the configuration",
        command: "write memory",
      },
    ];

    baseInstructions.cliCommands = `configure terminal
!
aaa-server BULA-RADIUS protocol radius
aaa-server BULA-RADIUS (inside) host ${radiusServer}
  key ${radiusSecret}
  authentication-port ${radiusPort}
  accounting-port ${acctPort}
!
aaa authentication match BULA-AUTH inside BULA-RADIUS
aaa accounting match BULA-ACCT inside BULA-RADIUS
!
write memory`;

  } else if (configMethod === "fmc") {
    // Cisco Firepower Management Center
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access FMC",
        description: "Log into Firepower Management Center",
      },
      {
        step: 2,
        title: "Navigate to RADIUS Settings",
        description: "Go to System → Integration → Realms",
      },
      {
        step: 3,
        title: "Add RADIUS Server",
        description: "Click 'Add Realm' and configure:",
        config: {
          "Name": "Bula-RADIUS",
          "Type": "RADIUS",
          "Server Address": radiusServer,
          "Authentication Port": radiusPort,
          "Accounting Port": acctPort,
          "Shared Secret": radiusSecret,
        },
      },
      {
        step: 4,
        title: "Apply to Policy",
        description: "Associate the RADIUS realm with your access policy",
      },
      {
        step: 5,
        title: "Deploy Changes",
        description: "Deploy the updated configuration to managed devices",
      },
    ];

  } else if (configMethod === "web") {
    // CBS series web interface
    baseInstructions.steps = [
      {
        step: 1,
        title: "Access Web Interface",
        description: "Log into the switch web interface",
      },
      {
        step: 2,
        title: "Navigate to RADIUS",
        description: "Go to Security → RADIUS",
      },
      {
        step: 3,
        title: "Add RADIUS Server",
        description: "Click 'Add' and configure:",
        config: {
          "Server IP": radiusServer,
          "Authentication Port": radiusPort,
          "Accounting Port": acctPort,
          "Secret Key": radiusSecret,
          "Status": "Active",
        },
      },
      {
        step: 4,
        title: "Configure 802.1X",
        description: "Go to Security → 802.1X and enable:",
        config: {
          "802.1X Authentication": "Enabled",
          "RADIUS Server": radiusServer,
        },
      },
      {
        step: 5,
        title: "Apply Changes",
        description: "Click 'Apply' to save the configuration",
      },
    ];
  }

  baseInstructions.notes = [
    "Ensure RADIUS server is reachable from the Cisco device",
    "The shared secret must match exactly on both devices",
    "Test authentication with a known user before deploying",
    modelInfo.notes,
  ];

  if (modelInfo.supports?.wpa3) {
    baseInstructions.notes.push("This device supports WPA3-Enterprise for enhanced security");
  }

  if (modelInfo.supports?.dot1x) {
    baseInstructions.notes.push("802.1X port-based authentication is supported");
  }

  return baseInstructions;
}

/**
 * Get hotspot/guest portal configuration for Cisco
 * @param {string} model - Device model
 * @param {Object} portalConfig - Portal configuration
 * @returns {Object} Hotspot configuration
 */
function getHotspotConfigInstructions(model, portalConfig) {
  const { portalUrl, redirectUrl, radiusServer, radiusSecret } = portalConfig;

  const modelInfo = CISCO_MODELS[model] || CISCO_MODELS["OTHER"];

  const instructions = {
    title: `Guest Portal Configuration for ${modelInfo.name}`,
    model,
    category: modelInfo.category,
    steps: [],
    notes: [],
    cliCommands: null,
  };

  if (modelInfo.configMethod === "meraki-dashboard") {
    instructions.steps = [
      {
        step: 1,
        title: "Configure Splash Page",
        description: "Go to Wireless → Configure → Splash page",
      },
      {
        step: 2,
        title: "Set Splash Type",
        description: "Configure splash page settings:",
        config: {
          "Splash page": "Sign-on with my RADIUS server",
          "Controller disconnection behavior": "Open",
        },
      },
      {
        step: 3,
        title: "Configure Custom Splash URL",
        description: "Enable custom splash URL:",
        config: {
          "Use custom splash URL": "Enabled",
          "Custom splash URL": portalUrl,
        },
      },
      {
        step: 4,
        title: "Configure Walled Garden",
        description: "Add allowed hosts before authentication:",
        config: {
          "Walled garden": [
            portalUrl.replace(/^https?:\/\//, "").split("/")[0],
            "*.flutterwave.com",
            "*.yo.co.ug",
          ].join("\n"),
        },
      },
    ];
  } else if (modelInfo.configMethod === "aireos" || modelInfo.category === "wlc") {
    instructions.steps = [
      {
        step: 1,
        title: "Configure Web Auth",
        description: "Go to SECURITY → Web Auth → Web Login Page",
      },
      {
        step: 2,
        title: "Set External URL",
        description: "Configure external web authentication:",
        config: {
          "Web Authentication Type": "External (Redirect to external server)",
          "Redirect URL After Login": redirectUrl || portalUrl,
          "External WebAuth URL": portalUrl,
        },
      },
      {
        step: 3,
        title: "Configure WLAN Security",
        description: "Go to WLANs → [Guest WLAN] → Security → Layer 3:",
        config: {
          "Layer 3 Security": "Web Policy",
          "Web Policy Type": "Authentication",
          "Preauthentication ACL": "Allow RADIUS and portal traffic",
        },
      },
      {
        step: 4,
        title: "Create Pre-Auth ACL",
        description: "Go to SECURITY → Access Control Lists and create ACL for portal access",
      },
    ];

    instructions.cliCommands = `# Configure External Web Auth
config wlan security web-auth enable <wlan-id>
config wlan security web-auth server-precedence <wlan-id> local radius
config wlan custom-web webauth-type external <wlan-id>
config wlan custom-web ext-webauth-url ${portalUrl} <wlan-id>
config wlan custom-web redirect-url ${redirectUrl || portalUrl} <wlan-id>`;
  }

  instructions.notes = [
    "Guest portal URL must be accessible from the client network",
    "Add payment gateway domains to the walled garden/pre-auth ACL",
    "Test the complete flow from a client device",
    "Consider timeout settings for guest sessions",
  ];

  return instructions;
}

/**
 * Test if a Cisco device is reachable
 * @param {string} ipAddress - Device IP address
 * @returns {Promise<Object>} Test result
 */
async function testDeviceConnection(ipAddress) {
  try {
    // Try HTTPS first (most Cisco devices use HTTPS for management)
    const https = require("https");
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const response = await axios.get(`https://${ipAddress}`, {
      httpsAgent,
      timeout: 5000,
      validateStatus: () => true,
    });

    if (response.status === 200 || response.status === 302 || response.status === 401 || response.status === 403) {
      return {
        success: true,
        message: "Device is reachable (HTTPS)",
        httpStatus: response.status,
      };
    }
  } catch (e) {
    // Try HTTP as fallback
    try {
      const response = await axios.get(`http://${ipAddress}`, {
        timeout: 5000,
        validateStatus: () => true,
      });

      if (response.status === 200 || response.status === 302 || response.status === 401) {
        return {
          success: true,
          message: "Device is reachable (HTTP)",
          httpStatus: response.status,
        };
      }
    } catch (httpError) {
      // Device not reachable via HTTP/HTTPS
    }
  }

  return {
    success: false,
    message: "Device unreachable via HTTP/HTTPS",
  };
}

/**
 * Validate Cisco device configuration
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

  if (config.model && !CISCO_MODELS[config.model]) {
    warnings.push(`Unknown model "${config.model}" - using generic settings`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  CISCO_CATEGORIES,
  CISCO_MODELS,
  getRadiusConfigInstructions,
  getHotspotConfigInstructions,
  testDeviceConnection,
  validateConfig,
};
