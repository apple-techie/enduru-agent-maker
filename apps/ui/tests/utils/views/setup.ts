import { Page, Locator } from '@playwright/test';
import { getByTestId } from '../core/elements';
import { waitForElement } from '../core/waiting';

/**
 * Wait for setup view to be visible
 */
export async function waitForSetupView(page: Page): Promise<Locator> {
  return waitForElement(page, 'setup-view', { timeout: 10000 });
}

/**
 * Click "Get Started" button on setup welcome step
 */
export async function clickSetupGetStarted(page: Page): Promise<void> {
  const button = await getByTestId(page, 'setup-start-button');
  await button.click();
}

/**
 * Click continue on Claude setup step
 */
export async function clickClaudeContinue(page: Page): Promise<void> {
  const button = await getByTestId(page, 'claude-next-button');
  await button.click();
}

/**
 * Click finish on setup complete step
 */
export async function clickSetupFinish(page: Page): Promise<void> {
  const button = await getByTestId(page, 'setup-finish-button');
  await button.click();
}

/**
 * Enter Anthropic API key in setup
 */
export async function enterAnthropicApiKey(page: Page, apiKey: string): Promise<void> {
  // Click "Use Anthropic API Key Instead" button
  const useApiKeyButton = await getByTestId(page, 'use-api-key-button');
  await useApiKeyButton.click();

  // Enter the API key
  const input = await getByTestId(page, 'anthropic-api-key-input');
  await input.fill(apiKey);

  // Click save button
  const saveButton = await getByTestId(page, 'save-anthropic-key-button');
  await saveButton.click();
}

/**
 * Enter OpenAI API key in setup
 */
export async function enterOpenAIApiKey(page: Page, apiKey: string): Promise<void> {
  // Click "Enter OpenAI API Key" button
  const useApiKeyButton = await getByTestId(page, 'use-openai-key-button');
  await useApiKeyButton.click();

  // Enter the API key
  const input = await getByTestId(page, 'openai-api-key-input');
  await input.fill(apiKey);

  // Click save button
  const saveButton = await getByTestId(page, 'save-openai-key-button');
  await saveButton.click();
}
