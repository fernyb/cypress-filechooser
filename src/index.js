const CDP = require('chrome-remote-interface');

let connectionDetails = {
  port: 0,
};

function ensureRdpPort(browser, args) {
  const existing = args.find(arg => arg.slice(0, 23) === '--remote-debugging-port');

  if (existing) {
    return Number(existing.split('=')[1]);
  }

  if (browser.name === "electron") {
    if (process.env.ELECTRON_EXTRA_LAUNCH_ARGS) {
      const envPortFound = process.env.ELECTRON_EXTRA_LAUNCH_ARGS.split(" ").find((arg) => arg.includes("remote-debugging-port"));
      if (envPortFound) {
        const port = envPortFound.split("=", 2)[1];
        args.push(`--remote-debugging-port=${port}`)
        return port;
      }
      throw new Error("--remote-debugging-port not found. Please set environment variable ELECTRON_EXTRA_LAUNCH_ARGS with remote debugging port");
    }
    throw new Error("environment variable ELECTRON_EXTRA_LAUNCH_ARGS is required for using FileChooser plugin");
  }

  const randomPort = 40000 + Math.round(Math.random() * 25000)
  args.push(`--remote-debugging-port=${randomPort}`)

  return randomPort;
}

function fileUploadClick(opts) {
  return new Promise((resolve) => {
    connectAndDo({
      onConnect: (client) => {
        return new Promise(async (done) => {
          const { DOM, Page, Runtime, Input } = client;

          await Page.enable();
          await Runtime.enable();
          await DOM.enable();

          await Page.setInterceptFileChooserDialog({ enabled: true });

          const fileInputResult = await Runtime.evaluate({
            expression: `document.querySelector(".aut-iframe").contentWindow.document.querySelector("${opts.fileInputSelector}")`
          });

          const iframeResults = await Runtime.evaluate({ 
            expression: `
              (() => {
                const iframe = document.querySelector(".aut-iframe").contentWindow;
                function offset(el) {
                  const rect = el.getBoundingClientRect();
                  const scrollLeft = iframe.window.pageXOffset || iframe.document.documentElement.scrollLeft;
                  const scrollTop = iframe.window.pageYOffset || iframe.document.documentElement.scrollTop;
                  return { top: rect.top + scrollTop, left: rect.left + scrollLeft };
                }
                const div = iframe.document.querySelector('${opts.clickElementSelector}');
                const computedStyle = window.getComputedStyle(div);
                const computedWidth = Number(computedStyle.width.replace("px", ""));
                const computedHeight = Number(computedStyle.height.replace("px", ""));

                const divOffset = offset(div);
                divOffset.width = computedWidth;
                divOffset.height = computedHeight;
                divOffset.x = divOffset.top + (computedWidth / 2);
                divOffset.y = divOffset.left + (computedWidth / 2);

                return JSON.stringify(divOffset);
              })();
            `
          });

          const { x, y } = JSON.parse(iframeResults.result.value);

          const { objectId } = fileInputResult.result;
          const { node } = await DOM.describeNode({ objectId });
          const { backendNodeId } = node;

          await Input.dispatchMouseEvent({
            x,
            y,
            type: "mouseMoved",
            button: "none",
            pointerType: "mouse"
          });

          await Input.dispatchMouseEvent({
            type: "mousePressed",
            x,
            y,
            clickCount: 1,
            buttons: 1,
            pointerType: "mouse",
            button: "left",
          });

          await Input.dispatchMouseEvent({
            type: "mouseReleased",
            x,
            y,
            clickCount: 1,
            buttons: 1,
            pointerType: "mouse",
            button: "left",
          });

          // We should use Cypress Fixtures as the default path and search for the file.
          const files = [opts.filePath];
          
          await DOM.setFileInputFiles({
            objectId,
            files,
            backendNodeId
          });

          await Page.setInterceptFileChooserDialog({ enabled: false });

          done();
        });
      }, 
      onFinally: () => {
        resolve(connectionDetails);
      }
    });
  });
}

function connectAndDo(opts = {}) {
  const getTargets = () => {
    return new Promise((resolve) => {
      CDP.List(connectionDetails, (err, targets) => {
        if (!err) {
          resolve(targets);
        } else {
          resolve([]);
        }
      });
    });
  };

  const tryConnect = async () => {
    const targets = await getTargets();
    const target = targets.find((t) => t.url.includes("http://") || t.url.includes("https://"));
    if (!target) throw new Error("Target not Found");

    CDP({ ...connectionDetails, target }, async (client) => {
      try {
        await opts.onConnect(client, targets);
      } catch (err) {
        console.log("------------------ ERROR ---------------------------");
        console.log(err);
        console.log("----------------------------------------------------");
      } finally {
        if (opts.onFinally) {
          opts.onFinally();
        }
        await client.close();
      }
    }).on('error', (err) => {
      setTimeout(tryConnect, 100);
    })
  };

  tryConnect();
}

function browserLaunchHandler(browser = {}, launchOptions) {
  const args = launchOptions.args || launchOptions;
  connectionDetails.port = ensureRdpPort(browser, args);
  return launchOptions;
}

function install(on) {
  on('before:browser:launch', browserLaunchHandler);
  on("task", {
    fileUploadClick
  });
}

module.exports = {
  install,
  fileUploadClick,
};
