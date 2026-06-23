const fs = require('fs');
const puppeteer = require('puppeteer'); // v23.0.0 or later

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    const timeout = 5000;
    page.setDefaultTimeout(timeout);

    const lhApi = await import('lighthouse'); // v10.0.0 or later
    const flags = {
        screenEmulation: {
            disabled: true
        }
    }
    const config = lhApi.desktopConfig;
    const lhFlow = await lhApi.startFlow(page, {name: 'Recording 6/23/2026 at 9:00:54 PM', config, flags});
    {
        const targetPage = page;
        await targetPage.setViewport({
            width: 1012,
            height: 551
        })
    }
    await lhFlow.startNavigation();
    {
        const targetPage = page;
        await targetPage.goto('https://didactic-journey-r44rq4v9j55rh64q-5173.app.github.dev/');
    }
    await lhFlow.endNavigation();
    await lhFlow.startTimespan();
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('rect:nth-of-type(3)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/svg/rect[3])'),
            targetPage.locator(':scope >>> rect:nth-of-type(3)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 65.22915649414062,
                y: 48.77874755859375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('rect:nth-of-type(6)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/svg/rect[6])'),
            targetPage.locator(':scope >>> rect:nth-of-type(6)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 21.979156494140625,
                y: 50.798736572265625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('rect:nth-of-type(9)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/svg/rect[9])'),
            targetPage.locator(':scope >>> rect:nth-of-type(9)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 1.7291259765625,
                y: 40.9920654296875,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('rect:nth-of-type(12)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/svg/rect[12])'),
            targetPage.locator(':scope >>> rect:nth-of-type(12)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 34.4791259765625,
                y: 51.15875244140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(24h)'),
            targetPage.locator('main > div > div:nth-of-type(2) button:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div[1]/div/button[1])'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(2) button:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 23.7916259765625,
                y: 23.052078247070312,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(7d)'),
            targetPage.locator('#root > div > div button:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div[1]/div/button[2])'),
            targetPage.locator(':scope >>> #root > div > div button:nth-of-type(2)'),
            targetPage.locator('::-p-text(7d)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 15.89581298828125,
                y: 21.052078247070312,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Refresh) >>>> ::-p-aria([role=\\"image\\"])'),
            targetPage.locator('main > div > div:nth-of-type(1) svg'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[1]/div[2]/button/svg)'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(1) svg')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 4.9166259765625,
                y: 11,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(24h)'),
            targetPage.locator('main > div > div:nth-of-type(2) button:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div[1]/div/button[1])'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(2) button:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 21.7916259765625,
                y: 1.0520782470703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Refresh)'),
            targetPage.locator('main > div > div:nth-of-type(1) button'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[1]/div[2]/button)'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(1) button'),
            targetPage.locator('::-p-text(Refresh)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 51.58331298828125,
                y: 13,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div:nth-of-type(3) > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[1]/div)'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(3) > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-text(Open cases0)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 84,
                y: 39.67706298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div:nth-of-type(3) > div:nth-of-type(2) > div > div:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div[1])'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(3) > div:nth-of-type(2) > div > div:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 36.166656494140625,
                y: 11.010406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div:nth-of-type(3) > div:nth-of-type(3) > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[3]/div)'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(3) > div:nth-of-type(3) > div'),
            targetPage.locator('::-p-text(True positives0)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 137.6666259765625,
                y: 66.67707824707031,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(4) div:nth-of-type(3)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[4]/div/div[3])'),
            targetPage.locator(':scope >>> div:nth-of-type(4) div:nth-of-type(3)'),
            targetPage.locator('::-p-text(752 tokens)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 25.83331298828125,
                y: 9.447906494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(5) > div:nth-of-type(1) > div > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[5]/div[1]/div/div)'),
            targetPage.locator(':scope >>> div:nth-of-type(5) > div:nth-of-type(1) > div > div'),
            targetPage.locator('::-p-text(RAG documents3)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 62,
                y: 73.07290649414062,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Document text)'),
            targetPage.locator('#\\:r4\\:'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r4:\\"])'),
            targetPage.locator(':scope >>> #\\:r4\\:')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 138.3333282470703,
                y: 76.61457824707031,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(e.g. brute force from a known scanner)'),
            targetPage.locator('div.css-x85v3e-euiFlexGroup-responsive-wrap-l-flexStart-stretch-row > div:nth-of-type(2) input'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[7]/div[2]/div/div[4]/div/input)'),
            targetPage.locator(':scope >>> div.css-x85v3e-euiFlexGroup-responsive-wrap-l-flexStart-stretch-row > div:nth-of-type(2) input')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 143,
                y: 16.61456298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Source \\(optional\\))'),
            targetPage.locator('#\\:r3\\:'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r3:\\"])'),
            targetPage.locator(':scope >>> #\\:r3\\:')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 66.83331298828125,
                y: 13.61456298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Title[role=\\"textbox\\"])'),
            targetPage.locator('#\\:r2\\:'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r2:\\"])'),
            targetPage.locator(':scope >>> #\\:r2\\:')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 79.33332824707031,
                y: 12.61456298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Overview)'),
            targetPage.locator('aside div:nth-of-type(1) > button:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[1])'),
            targetPage.locator(':scope >>> aside div:nth-of-type(1) > button:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 60,
                y: 4.4375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div:nth-of-type(3) > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[1]/div)'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(3) > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-text(Open cases0)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 128,
                y: 62.010406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(5) > div:nth-of-type(1) > div > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[5]/div[1]/div/div)'),
            targetPage.locator(':scope >>> div:nth-of-type(5) > div:nth-of-type(1) > div > div'),
            targetPage.locator('::-p-text(RAG documents3)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 172,
                y: 15.40625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('aside div:nth-of-type(1) > button:nth-of-type(1) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[1]/span[2])'),
            targetPage.locator(':scope >>> aside div:nth-of-type(1) > button:nth-of-type(1) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Overview)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 37,
                y: 13.4375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(5) > div:nth-of-type(2) > div > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[5]/div[2]/div/div)'),
            targetPage.locator(':scope >>> div:nth-of-type(5) > div:nth-of-type(2) > div > div'),
            targetPage.locator('::-p-text(RAG chunks18)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 67.44790649414062,
                y: 33.072906494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('aside div:nth-of-type(1) > button:nth-of-type(1) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[1]/span[2])'),
            targetPage.locator(':scope >>> aside div:nth-of-type(1) > button:nth-of-type(1) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Overview)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 20,
                y: 6.71875,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(5) > div:nth-of-type(3) > div > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[5]/div[3]/div/div)'),
            targetPage.locator(':scope >>> div:nth-of-type(5) > div:nth-of-type(3) > div > div'),
            targetPage.locator('::-p-text(Memory facts0)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 32.8853759765625,
                y: 10.40625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Overview)'),
            targetPage.locator('aside div:nth-of-type(1) > button:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[1])'),
            targetPage.locator(':scope >>> aside div:nth-of-type(1) > button:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 54,
                y: 26.4375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) > div:nth-of-type(4) div:nth-of-type(2) > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[4]/div/div[2]/div)'),
            targetPage.locator(':scope >>> div:nth-of-type(3) > div:nth-of-type(4) div:nth-of-type(2) > div')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 35.83331298828125,
                y: 9.447906494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div:nth-of-type(3) > div:nth-of-type(3) div:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[3]/div/div[2])'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(3) > div:nth-of-type(3) div:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 89,
                y: 1.447906494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div:nth-of-type(3) > div:nth-of-type(2) > div > div:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div[1])'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(3) > div:nth-of-type(2) > div > div:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 129.16665649414062,
                y: 11.010406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div:nth-of-type(3) > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[1]/div)'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(3) > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-text(Open cases0)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 93,
                y: 34.67707824707031,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(4) div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[7]/div[4]/div[1]/div[2]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(4) div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-text(Manage)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 19.30206298828125,
                y: 7.158966064453125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiPanel span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div/div[2]/button/span/span)'),
            targetPage.locator(':scope >>> div.euiPanel span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 61.2603759765625,
                y: 3.883575439453125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Closes this modal window)'),
            targetPage.locator('div:nth-of-type(2) > div > button'),
            targetPage.locator('::-p-xpath(/html/body/div[2]/div[2]/div/button)'),
            targetPage.locator(':scope >>> div:nth-of-type(2) > div > button')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 22,
                y: 10.440448760986328,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('aside div:nth-of-type(1) > button:nth-of-type(1) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[1]/span[2])'),
            targetPage.locator(':scope >>> aside div:nth-of-type(1) > button:nth-of-type(1) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Overview)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 38,
                y: 10.4375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiFlexGrid > div:nth-of-type(3) > div:nth-of-type(3) > div:nth-of-type(1) > div:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[7]/div[3]/div[3]/div[1]/div[1])'),
            targetPage.locator(':scope >>> div.euiFlexGrid > div:nth-of-type(3) > div:nth-of-type(3) > div:nth-of-type(1) > div:nth-of-type(1)'),
            targetPage.locator('::-p-text(text-embedding-3-smallUSD0.0000)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 229.33331298828125,
                y: 6.510406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div.socCard > div:nth-of-type(1) > div:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[9]/div[1]/div[2])'),
            targetPage.locator(':scope >>> main > div > div.socCard > div:nth-of-type(1) > div:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 48,
                y: 0.17706298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main > div > div.socCard div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[9]/div[1]/div[2]/button/span/span)'),
            targetPage.locator(':scope >>> main > div > div.socCard div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-text(View all)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 18,
                y: 15.28570556640625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Refresh)'),
            targetPage.locator('main > div > div:nth-of-type(1) > button'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[1]/button)'),
            targetPage.locator(':scope >>> main > div > div:nth-of-type(1) > button'),
            targetPage.locator('::-p-text(Refresh)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 41.58331298828125,
                y: 27,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-rwiwai-euiFlexGroup-responsive-m-flexStart-stretch-row > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div[1]/div)'),
            targetPage.locator(':scope >>> div.css-rwiwai-euiFlexGroup-responsive-m-flexStart-stretch-row > div:nth-of-type(1) > div'),
            targetPage.locator('::-p-text(Total cases0)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 75,
                y: 13.71875,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-rwiwai-euiFlexGroup-responsive-m-flexStart-stretch-row > div:nth-of-type(2) div:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div[2]/div/div[2])'),
            targetPage.locator(':scope >>> div.css-rwiwai-euiFlexGroup-responsive-m-flexStart-stretch-row > div:nth-of-type(2) div:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 70.16665649414062,
                y: 6.4895782470703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(2) button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[2]/div/button[2]/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(2) button:nth-of-type(2) > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 4,
                y: 14.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(2) button:nth-of-type(3) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[2]/div/button[3]/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(2) button:nth-of-type(3) > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 42.21875,
                y: 11.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(2) button:nth-of-type(4) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[2]/div/button[4]/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(2) button:nth-of-type(4) > span > span'),
            targetPage.locator('::-p-text(Closed)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 7.4166259765625,
                y: 9.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Any verdict)'),
            targetPage.locator('div:nth-of-type(3) button.euiFilterButton-isSelected'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[3]/div/button[1])'),
            targetPage.locator(':scope >>> div:nth-of-type(3) button.euiFilterButton-isSelected')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 85,
                y: 19.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[3]/div/button[2]/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(3) button:nth-of-type(2) > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 78.75,
                y: 5.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) button:nth-of-type(3) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[3]/div/button[3]/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(3) button:nth-of-type(3) > span > span'),
            targetPage.locator('::-p-text(False positive)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 45.385406494140625,
                y: 9.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) button:nth-of-type(4) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[3]/div/button[4]/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(3) button:nth-of-type(4) > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 66.7916259765625,
                y: 16.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1nthddw-euiFlexGroup-wrap-m-flexStart-center-row > div:nth-of-type(4) button.euiFilterButton-isSelected > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[4]/div/button[1]/span/span)'),
            targetPage.locator(':scope >>> div.css-1nthddw-euiFlexGroup-wrap-m-flexStart-center-row > div:nth-of-type(4) button.euiFilterButton-isSelected > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 18.21875,
                y: 8.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1nthddw-euiFlexGroup-wrap-m-flexStart-center-row > div:nth-of-type(4) button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[4]/div/button[2]/span/span)'),
            targetPage.locator(':scope >>> div.css-1nthddw-euiFlexGroup-wrap-m-flexStart-center-row > div:nth-of-type(4) button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-text(Unassigned)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 13.98956298828125,
                y: 15.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1nthddw-euiFlexGroup-wrap-m-flexStart-center-row > div:nth-of-type(4) button:nth-of-type(3) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[4]/div/button[3]/span/span)'),
            targetPage.locator(':scope >>> div.css-1nthddw-euiFlexGroup-wrap-m-flexStart-center-row > div:nth-of-type(4) button:nth-of-type(3) > span > span'),
            targetPage.locator('::-p-text(Has comments)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 3.6353759765625,
                y: 8.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('label'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[5]/div/div[1]/label)'),
            targetPage.locator(':scope >>> label'),
            targetPage.locator('::-p-text(Assignee)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 23.333328247070312,
                y: 18.260406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Filter cases by assignee)'),
            targetPage.locator('select'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[4]/div[5]/div/div[2]/select)'),
            targetPage.locator(':scope >>> select'),
            targetPage.locator('::-p-text(__any__)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 38.83331298828125,
                y: 4.59375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(1) > button:nth-of-type(3) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[3]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(1) > button:nth-of-type(3) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Investigate)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 26,
                y: 15.03125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[1]/fieldset/div/button[2]/span/span)'),
            targetPage.locator(':scope >>> button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-text(User)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 9.104156494140625,
                y: 13.385406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#root > div > div button:nth-of-type(3) > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[1]/fieldset/div/button[3]/span)'),
            targetPage.locator(':scope >>> #root > div > div button:nth-of-type(3) > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 39.96875,
                y: 32.385406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('main div:nth-of-type(4) > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[4]/span)'),
            targetPage.locator(':scope >>> main div:nth-of-type(4) > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 94.33331298828125,
                y: 23.385406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Lookback window)'),
            targetPage.locator('select'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[3]/div[2]/div/select)'),
            targetPage.locator(':scope >>> select'),
            targetPage.locator('::-p-text(now-24h)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 100,
                y: 33.385406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Lookback window)'),
            targetPage.locator('select'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[3]/div[2]/div/select)'),
            targetPage.locator(':scope >>> select'),
            targetPage.locator('::-p-text(now-24h)')
        ])
            .setTimeout(timeout)
            .fill('now-7d');
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Lookback window)'),
            targetPage.locator('select'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[3]/div[2]/div/select)'),
            targetPage.locator(':scope >>> select'),
            targetPage.locator('::-p-text(now-24h)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 48,
                y: 12.385406494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Lookback window)'),
            targetPage.locator('select'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[3]/div[2]/div/select)'),
            targetPage.locator(':scope >>> select'),
            targetPage.locator('::-p-text(now-24h)')
        ])
            .setTimeout(timeout)
            .fill('now-30d');
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(1) > button:nth-of-type(4) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[4]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(1) > button:nth-of-type(4) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Chat)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 5,
                y: 5.4895782470703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiFlexGroup > div:nth-of-type(1) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[4]/div[1]/button/span/span)'),
            targetPage.locator(':scope >>> div.euiFlexGroup > div:nth-of-type(1) span > span'),
            targetPage.locator('::-p-text(Show failed logins)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 73.48956298828125,
                y: 7.625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.socChat div.euiFlexGroup > div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[4]/div[2]/button/span/span)'),
            targetPage.locator(':scope >>> div.socChat div.euiFlexGroup > div:nth-of-type(2) span > span'),
            targetPage.locator("::-p-text(Summarize today\\'s)")
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 30.45831298828125,
                y: 14.625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.socChat div:nth-of-type(3) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[4]/div[3]/button/span/span)'),
            targetPage.locator(':scope >>> div.socChat div:nth-of-type(3) span > span'),
            targetPage.locator('::-p-text(Any brute-force)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 98.98956298828125,
                y: 7.291656494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiFlexGroup > div:nth-of-type(4) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[2]/div/div[4]/div[4]/button/span/span)'),
            targetPage.locator(':scope >>> div.euiFlexGroup > div:nth-of-type(4) span > span'),
            targetPage.locator('::-p-text(Which hosts had)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 44.98956298828125,
                y: 11.291656494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Metrics)'),
            targetPage.locator('div:nth-of-type(1) > button:nth-of-type(5)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[1]/button[5])'),
            targetPage.locator(':scope >>> div:nth-of-type(1) > button:nth-of-type(5)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 86,
                y: 19.104156494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-pmrxze-euiFlexGroup-responsive-wrap-m-flexStart-stretch-row > div:nth-of-type(3) > div > div:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[7]/div[3]/div/div[1])'),
            targetPage.locator(':scope >>> div.css-pmrxze-euiFlexGroup-responsive-wrap-m-flexStart-stretch-row > div:nth-of-type(3) > div > div:nth-of-type(1)'),
            targetPage.locator('::-p-text(Embedding model)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 98.21875,
                y: 6.17706298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Automated scans)'),
            targetPage.locator('nav > div:nth-of-type(2) > button:nth-of-type(1)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[2]/button[1])'),
            targetPage.locator(':scope >>> nav > div:nth-of-type(2) > button:nth-of-type(1)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 91,
                y: 25.84375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(2) > button:nth-of-type(2) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[2]/button[2]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(2) > button:nth-of-type(2) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Standup)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 27,
                y: 1.3333282470703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1ksp63d-euiFlexGroup-wrap-m-spaceBetween-center-row > div:nth-of-type(2) > div > div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[1]/div[2]/div/div[2]/button/span/span)'),
            targetPage.locator(':scope >>> div.css-1ksp63d-euiFlexGroup-wrap-m-spaceBetween-center-row > div:nth-of-type(2) > div > div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-text(Print)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 9.5625,
                y: 7.72271728515625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#root > div > div div:nth-of-type(3) > button > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[1]/div[2]/div/div[3]/button/span)'),
            targetPage.locator(':scope >>> #root > div > div div:nth-of-type(3) > button > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 34.1666259765625,
                y: 2.9084854125976562,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(2) > button:nth-of-type(3) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[2]/button[3]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(2) > button:nth-of-type(3) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Playbooks & Agents)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 56,
                y: 12.875,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Playbooks) >>>> ::-p-aria([role=\\"generic\\"])'),
            targetPage.locator('#playbooks > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"playbooks\\"]/span)'),
            targetPage.locator(':scope >>> #playbooks > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 39.53125,
                y: 26.177078247070312,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Agent personas) >>>> ::-p-aria([role=\\"generic\\"])'),
            targetPage.locator('#personas > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"personas\\"]/span)'),
            targetPage.locator(':scope >>> #personas > span'),
            targetPage.locator('::-p-text(Agent personas)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 29.333328247070312,
                y: 19.177078247070312,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) > button:nth-of-type(1) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[3]/button[1]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(3) > button:nth-of-type(1) > span:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 16,
                y: 16.979156494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Sources)'),
            targetPage.locator('div:nth-of-type(3) > button:nth-of-type(3)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[3]/button[3])'),
            targetPage.locator(':scope >>> div:nth-of-type(3) > button:nth-of-type(3)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 56,
                y: 5.59375,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) > button:nth-of-type(2) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[3]/button[2]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(3) > button:nth-of-type(2) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Memory)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 32,
                y: 8.64581298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) > button:nth-of-type(3) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[3]/button[3]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(3) > button:nth-of-type(3) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Sources)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 28,
                y: 11.3125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(3) > button:nth-of-type(4) > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[3]/button[4]/span[2])'),
            targetPage.locator(':scope >>> div:nth-of-type(3) > button:nth-of-type(4) > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(Cost & usage)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 36,
                y: 10.979156494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Settings)'),
            targetPage.locator('div:nth-of-type(3) > button:nth-of-type(5)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/aside/nav/div[3]/button[5])'),
            targetPage.locator(':scope >>> div:nth-of-type(3) > button:nth-of-type(5)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 75,
                y: 6.64581298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiSideNavItemButton > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e5254800-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[1]/span/span)'),
            targetPage.locator(':scope >>> div.euiSideNavItemButton > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 16,
                y: 9,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(2) > div > div:nth-of-type(1) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[1]/div[2]/div/div[1]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(2) > div > div:nth-of-type(1) span > span'),
            targetPage.locator('::-p-text(Re-run setup)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 24.6666259765625,
                y: 7.794593811035156,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(Close) >>>> ::-p-aria([role=\\"graphics-symbol\\"])'),
            targetPage.locator('div.css-kyk508-euiFlexGroup-m-flexStart-center-row > div:nth-of-type(3) path'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/div[1]/div[3]/button/span/svg/path)'),
            targetPage.locator(':scope >>> div.css-kyk508-euiFlexGroup-m-flexStart-center-row > div:nth-of-type(3) path')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 2.13604736328125,
                y: 7.000629425048828,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiSideNavItem__items > div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[2]/button/span/span)'),
            targetPage.locator(':scope >>> div.euiSideNavItem__items > div:nth-of-type(2) span > span'),
            targetPage.locator('::-p-text(Polling)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 31,
                y: 7,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiSideNavItem__items > div:nth-of-type(3) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[3]/button/span/span)'),
            targetPage.locator(':scope >>> div.euiSideNavItem__items > div:nth-of-type(3) span > span'),
            targetPage.locator('::-p-text(Models)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 32,
                y: 17,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(4) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[4]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(4) span > span'),
            targetPage.locator('::-p-text(Secret keys)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 42,
                y: 5,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiSideNavItem__items > div:nth-of-type(3) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[3]/button/span/span)'),
            targetPage.locator(':scope >>> div.euiSideNavItem__items > div:nth-of-type(3) span > span'),
            targetPage.locator('::-p-text(Models)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 22,
                y: 3,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row > div.css-9sbomz-euiFlexItem-grow-1 > div > div > div.euiFlexGroup > div:nth-of-type(1) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r30:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row > div.css-9sbomz-euiFlexItem-grow-1 > div > div > div.euiFlexGroup > div:nth-of-type(1) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 115.33331298828125,
                y: 14.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row > div.css-9sbomz-euiFlexItem-grow-1 > div > div > div.euiFlexGroup > div:nth-of-type(1) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r30:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row > div.css-9sbomz-euiFlexItem-grow-1 > div > div > div.euiFlexGroup > div:nth-of-type(1) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 105.33331298828125,
                y: 22.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div > div > div.euiFlexGroup > div:nth-of-type(2) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r31:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div > div > div.euiFlexGroup > div:nth-of-type(2) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 121.33331298828125,
                y: 12.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row > div.css-9sbomz-euiFlexItem-grow-1 > div > div > div.euiFlexGroup'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div/div[3])'),
            targetPage.locator(':scope >>> div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row > div.css-9sbomz-euiFlexItem-grow-1 > div > div > div.euiFlexGroup')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 129.33331298828125,
                y: 227.3333282470703,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.euiFlexGroup > div:nth-of-type(3) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r32:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div.euiFlexGroup > div:nth-of-type(3) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 93.33331298828125,
                y: 18.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(4) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r33:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div:nth-of-type(4) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 85.33331298828125,
                y: 8.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(5) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r34:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div:nth-of-type(5) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 129.33331298828125,
                y: 26.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(6) div.euiFormRow__labelWrapper'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r35:-row\\"]/div[1])'),
            targetPage.locator(':scope >>> div:nth-of-type(6) div.euiFormRow__labelWrapper')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 119.33331298828125,
                y: 4.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(6) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r35:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div:nth-of-type(6) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 109.33331298828125,
                y: 3.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(7) select'),
            targetPage.locator('::-p-xpath(//*[@id=\\":r36:\\"]/div/div/div/select)'),
            targetPage.locator(':scope >>> div:nth-of-type(7) select')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 171.33331298828125,
                y: 5.33331298828125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3])'),
            targetPage.locator(':scope >>> div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 146,
                y: 468,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(4) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[4]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(4) span > span'),
            targetPage.locator('::-p-text(Secret keys)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 49,
                y: 7,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(5) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[5]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(5) span > span'),
            targetPage.locator('::-p-text(Correlation &)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 64,
                y: 13,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(6) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[6]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(6) span > span'),
            targetPage.locator('::-p-text(Enrichment)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 14,
                y: 4,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-kpsrin-euiFlexItem-growZero div:nth-of-type(7) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[7]/button/span/span)'),
            targetPage.locator(':scope >>> div.css-kpsrin-euiFlexItem-growZero div:nth-of-type(7) span > span'),
            targetPage.locator('::-p-text(RAG)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 28,
                y: 14,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-kpsrin-euiFlexItem-growZero div:nth-of-type(8) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[8]/button/span/span)'),
            targetPage.locator(':scope >>> div.css-kpsrin-euiFlexItem-growZero div:nth-of-type(8) span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 39,
                y: 7,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(9) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[9]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(9) span > span'),
            targetPage.locator('::-p-text(Automation &)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 38,
                y: 5,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div:nth-of-type(10) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"euiSideNav_e90652c0-6f18-11f1-b177-3107c6e18e67_content\\"]/div/div[2]/div[10]/button/span/span)'),
            targetPage.locator(':scope >>> div:nth-of-type(10) span > span'),
            targetPage.locator('::-p-text(Branding)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 20,
                y: 0,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('button:nth-of-type(3) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div/fieldset/div/button[3]/span/span)'),
            targetPage.locator(':scope >>> button:nth-of-type(3) > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 10.98956298828125,
                y: 4.666656494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('fieldset button:nth-of-type(1) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div/fieldset/div/button[1]/span/span)'),
            targetPage.locator(':scope >>> fieldset button:nth-of-type(1) > span > span'),
            targetPage.locator('::-p-text(Light)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 0.33331298828125,
                y: 6.666656494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div/fieldset/div/button[2]/span/span)'),
            targetPage.locator(':scope >>> button:nth-of-type(2) > span > span'),
            targetPage.locator('::-p-text(Dark)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 7.125,
                y: 9.666656494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('button:nth-of-type(3) > span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div/fieldset/div/button[3]/span/span)'),
            targetPage.locator(':scope >>> button:nth-of-type(3) > span > span')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 13.98956298828125,
                y: 5.666656494140625,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row div.css-wil1od-euiFlexGroup-s-flexStart-stretch-row > div:nth-of-type(1) span > span'),
            targetPage.locator('::-p-xpath(//*[@id=\\"root\\"]/div/div/main/div/div[3]/div[2]/div/div/div[22]/div[1]/button/span/span)'),
            targetPage.locator(':scope >>> div.css-1p7y8nb-euiFlexGroup-responsive-l-flexStart-flexStart-row div.css-wil1od-euiFlexGroup-s-flexStart-stretch-row > div:nth-of-type(1) span > span'),
            targetPage.locator('::-p-text(Save branding)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 25.33331298828125,
                y: 3.5509033203125,
              },
            });
    }
    await lhFlow.endTimespan();
    const lhFlowReport = await lhFlow.generateReport();
    fs.writeFileSync(__dirname + '/flow.report.html', lhFlowReport)

    await browser.close();

})().catch(err => {
    console.error(err);
    process.exit(1);
});
