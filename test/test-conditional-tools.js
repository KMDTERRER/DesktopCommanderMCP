#!/usr/bin/env node
/**
 * Test: Verify conditional tool registration based on client name
 * Tests that give_feedback_to_desktop_commander is excluded for desktop-commander client
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function testConditionalTools() {
    console.log('\n=== Test: Conditional Tool Registration ===\n');

    // Test 1: Regular client (should include feedback tool)
    console.log('Test 1: Testing with regular client (should include feedback tool)...');
    const regularClient = new Client(
        {
            name: "test-client",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    const regularTransport = new StdioClientTransport({
        command: "node",
        args: ["../dist/index.js", "--no-onboarding"]
    });

    await regularClient.connect(regularTransport);
    const regularTools = await regularClient.listTools();
    const serverInstructions = regularClient.getInstructions();
    const mcpListTool = regularTools.tools.find(t => t.name === 'mcp_list_tools');
    const mcpCallTool = regularTools.tools.find(t => t.name === 'mcp_call_tool');

    if (!serverInstructions?.includes('prefer it over generic filesystem text search/read') || !serverInstructions.includes('mcp_list_tools')) {
        console.log('   ❌ FAIL: semantic-first MCP routing instructions are missing');
        process.exit(1);
    }
    if (!mcpListTool?.description?.includes('codebase navigation') || !mcpCallTool?.description?.includes('prefer applicable semantic tools')) {
        console.log('   ❌ FAIL: MCP proxy descriptions do not advertise semantic-first routing');
        process.exit(1);
    }
    if (Object.prototype.hasOwnProperty.call(mcpCallTool.annotations || {}, 'destructiveHint')) {
        console.log('   ❌ FAIL: generic MCP proxy must not claim every downstream tool is destructive');
        process.exit(1);
    }
    console.log('   ✅ PASS: semantic-first MCP routing policy is exposed to the client');

    const hasFeedbackRegular = regularTools.tools.some(t => t.name === 'give_feedback_to_desktop_commander');
    console.log(`   Tools count: ${regularTools.tools.length}`);
    console.log(`   Has give_feedback_to_desktop_commander: ${hasFeedbackRegular}`);

    if (hasFeedbackRegular) {
        console.log('   ✅ PASS: Feedback tool is included for regular client');
    } else {
        console.log('   ❌ FAIL: Feedback tool should be included for regular client');
        process.exit(1);
    }

    await regularClient.close();

    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 2: desktop-commander-app client (should exclude feedback tool and get_prompts)
    console.log('\nTest 2: Testing with desktop-commander-app client (should exclude feedback tool and get_prompts)...');
    const dcClient = new Client(
        {
            name: "desktop-commander-app",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    const dcTransport = new StdioClientTransport({
        command: "node",
        args: ["../dist/index.js", "--no-onboarding"]
    });

    await dcClient.connect(dcTransport);
    const dcTools = await dcClient.listTools();

    const hasFeedbackDC = dcTools.tools.some(t => t.name === 'give_feedback_to_desktop_commander');
    const hasGetPromptsDC = dcTools.tools.some(t => t.name === 'get_prompts');
    console.log(`   Tools count: ${dcTools.tools.length}`);
    console.log(`   Has give_feedback_to_desktop_commander: ${hasFeedbackDC}`);
    console.log(`   Has get_prompts: ${hasGetPromptsDC}`);

    if (!hasFeedbackDC) {
        console.log('   ✅ PASS: Feedback tool is excluded for desktop-commander-app client');
    } else {
        console.log('   ❌ FAIL: Feedback tool should be excluded for desktop-commander-app client');
        process.exit(1);
    }

    if (!hasGetPromptsDC) {
        console.log('   ✅ PASS: get_prompts is excluded for desktop-commander-app client');
    } else {
        console.log('   ❌ FAIL: get_prompts should be excluded for desktop-commander-app client');
        process.exit(1);
    }

    await dcClient.close();

    console.log('\n=== All Tests Passed! ===\n');
}

testConditionalTools().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
