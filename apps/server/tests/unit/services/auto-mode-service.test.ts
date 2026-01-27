import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoModeService } from '@/services/auto-mode-service.js';
import type { Feature } from '@automaker/types';

describe('auto-mode-service.ts', () => {
  let service: AutoModeService;
  const mockEvents = {
    subscribe: vi.fn(),
    emit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AutoModeService(mockEvents as any);
  });

  describe('constructor', () => {
    it('should initialize with event emitter', () => {
      expect(service).toBeDefined();
    });
  });

  describe('startAutoLoop', () => {
    it('should throw if auto mode is already running', async () => {
      // Start first loop
      const promise1 = service.startAutoLoop('/test/project', 3);

      // Try to start second loop
      await expect(service.startAutoLoop('/test/project', 3)).rejects.toThrow('already running');

      // Cleanup
      await service.stopAutoLoop();
      await promise1.catch(() => {});
    });

    it('should emit auto mode start event', async () => {
      const promise = service.startAutoLoop('/test/project', 3);

      // Give it time to emit the event
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockEvents.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          message: expect.stringContaining('Auto mode started'),
        })
      );

      // Cleanup
      await service.stopAutoLoop();
      await promise.catch(() => {});
    });
  });

  describe('stopAutoLoop', () => {
    it('should stop the auto loop', async () => {
      const promise = service.startAutoLoop('/test/project', 3);

      const runningCount = await service.stopAutoLoop();

      expect(runningCount).toBe(0);
      await promise.catch(() => {});
    });

    it('should return 0 when not running', async () => {
      const runningCount = await service.stopAutoLoop();
      expect(runningCount).toBe(0);
    });
  });

  describe('getRunningAgents', () => {
    // Helper to access private concurrencyManager
    const getConcurrencyManager = (svc: AutoModeService) => (svc as any).concurrencyManager;

    // Helper to add a running feature via concurrencyManager
    const addRunningFeature = (
      svc: AutoModeService,
      feature: { featureId: string; projectPath: string; isAutoMode: boolean }
    ) => {
      getConcurrencyManager(svc).acquire(feature);
    };

    // Helper to get the featureLoader and mock its get method
    const mockFeatureLoaderGet = (svc: AutoModeService, mockFn: ReturnType<typeof vi.fn>) => {
      (svc as any).featureLoader = { get: mockFn };
    };

    it('should return empty array when no agents are running', async () => {
      const result = await service.getRunningAgents();

      expect(result).toEqual([]);
    });

    it('should return running agents with basic info when feature data is not available', async () => {
      // Arrange: Add a running feature via concurrencyManager
      addRunningFeature(service, {
        featureId: 'feature-123',
        projectPath: '/test/project/path',
        isAutoMode: true,
      });

      // Mock featureLoader.get to return null (feature not found)
      const getMock = vi.fn().mockResolvedValue(null);
      mockFeatureLoaderGet(service, getMock);

      // Act
      const result = await service.getRunningAgents();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        featureId: 'feature-123',
        projectPath: '/test/project/path',
        projectName: 'path',
        isAutoMode: true,
        title: undefined,
        description: undefined,
      });
    });

    it('should return running agents with title and description when feature data is available', async () => {
      // Arrange
      addRunningFeature(service, {
        featureId: 'feature-456',
        projectPath: '/home/user/my-project',
        isAutoMode: false,
      });

      const mockFeature: Partial<Feature> = {
        id: 'feature-456',
        title: 'Implement user authentication',
        description: 'Add login and signup functionality',
        category: 'auth',
      };

      const getMock = vi.fn().mockResolvedValue(mockFeature);
      mockFeatureLoaderGet(service, getMock);

      // Act
      const result = await service.getRunningAgents();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        featureId: 'feature-456',
        projectPath: '/home/user/my-project',
        projectName: 'my-project',
        isAutoMode: false,
        title: 'Implement user authentication',
        description: 'Add login and signup functionality',
      });
      expect(getMock).toHaveBeenCalledWith('/home/user/my-project', 'feature-456');
    });

    it('should handle multiple running agents', async () => {
      // Arrange
      addRunningFeature(service, {
        featureId: 'feature-1',
        projectPath: '/project-a',
        isAutoMode: true,
      });
      addRunningFeature(service, {
        featureId: 'feature-2',
        projectPath: '/project-b',
        isAutoMode: false,
      });

      const getMock = vi
        .fn()
        .mockResolvedValueOnce({
          id: 'feature-1',
          title: 'Feature One',
          description: 'Description one',
        })
        .mockResolvedValueOnce({
          id: 'feature-2',
          title: 'Feature Two',
          description: 'Description two',
        });
      mockFeatureLoaderGet(service, getMock);

      // Act
      const result = await service.getRunningAgents();

      // Assert
      expect(result).toHaveLength(2);
      expect(getMock).toHaveBeenCalledTimes(2);
    });

    it('should silently handle errors when fetching feature data', async () => {
      // Arrange
      addRunningFeature(service, {
        featureId: 'feature-error',
        projectPath: '/project-error',
        isAutoMode: true,
      });

      const getMock = vi.fn().mockRejectedValue(new Error('Database connection failed'));
      mockFeatureLoaderGet(service, getMock);

      // Act - should not throw
      const result = await service.getRunningAgents();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        featureId: 'feature-error',
        projectPath: '/project-error',
        projectName: 'project-error',
        isAutoMode: true,
        title: undefined,
        description: undefined,
      });
    });

    it('should handle feature with title but no description', async () => {
      // Arrange
      addRunningFeature(service, {
        featureId: 'feature-title-only',
        projectPath: '/project',
        isAutoMode: false,
      });

      const getMock = vi.fn().mockResolvedValue({
        id: 'feature-title-only',
        title: 'Only Title',
        // description is undefined
      });
      mockFeatureLoaderGet(service, getMock);

      // Act
      const result = await service.getRunningAgents();

      // Assert
      expect(result[0].title).toBe('Only Title');
      expect(result[0].description).toBeUndefined();
    });

    it('should handle feature with description but no title', async () => {
      // Arrange
      addRunningFeature(service, {
        featureId: 'feature-desc-only',
        projectPath: '/project',
        isAutoMode: false,
      });

      const getMock = vi.fn().mockResolvedValue({
        id: 'feature-desc-only',
        description: 'Only description, no title',
        // title is undefined
      });
      mockFeatureLoaderGet(service, getMock);

      // Act
      const result = await service.getRunningAgents();

      // Assert
      expect(result[0].title).toBeUndefined();
      expect(result[0].description).toBe('Only description, no title');
    });

    it('should extract projectName from nested paths correctly', async () => {
      // Arrange
      addRunningFeature(service, {
        featureId: 'feature-nested',
        projectPath: '/home/user/workspace/projects/my-awesome-project',
        isAutoMode: true,
      });

      const getMock = vi.fn().mockResolvedValue(null);
      mockFeatureLoaderGet(service, getMock);

      // Act
      const result = await service.getRunningAgents();

      // Assert
      expect(result[0].projectName).toBe('my-awesome-project');
    });

    it('should fetch feature data in parallel for multiple agents', async () => {
      // Arrange: Add multiple running features
      for (let i = 1; i <= 5; i++) {
        addRunningFeature(service, {
          featureId: `feature-${i}`,
          projectPath: `/project-${i}`,
          isAutoMode: i % 2 === 0,
        });
      }

      // Track call order
      const callOrder: string[] = [];
      const getMock = vi.fn().mockImplementation(async (projectPath: string, featureId: string) => {
        callOrder.push(featureId);
        // Simulate async delay to verify parallel execution
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { id: featureId, title: `Title for ${featureId}` };
      });
      mockFeatureLoaderGet(service, getMock);

      // Act
      const startTime = Date.now();
      const result = await service.getRunningAgents();
      const duration = Date.now() - startTime;

      // Assert
      expect(result).toHaveLength(5);
      expect(getMock).toHaveBeenCalledTimes(5);
      // If executed in parallel, total time should be ~10ms (one batch)
      // If sequential, it would be ~50ms (5 * 10ms)
      // Allow some buffer for execution overhead
      expect(duration).toBeLessThan(40);
    });
  });

  describe('detectOrphanedFeatures', () => {
    // Helper to mock featureLoader.getAll
    const mockFeatureLoaderGetAll = (svc: AutoModeService, mockFn: ReturnType<typeof vi.fn>) => {
      (svc as any).featureLoader = { getAll: mockFn };
    };

    // Helper to mock getExistingBranches
    const mockGetExistingBranches = (svc: AutoModeService, branches: string[]) => {
      (svc as any).getExistingBranches = vi.fn().mockResolvedValue(new Set(branches));
    };

    it('should return empty array when no features have branch names', async () => {
      const getAllMock = vi.fn().mockResolvedValue([
        { id: 'f1', title: 'Feature 1', description: 'desc', category: 'test' },
        { id: 'f2', title: 'Feature 2', description: 'desc', category: 'test' },
      ] satisfies Feature[]);
      mockFeatureLoaderGetAll(service, getAllMock);
      mockGetExistingBranches(service, ['main', 'develop']);

      const result = await service.detectOrphanedFeatures('/test/project');

      expect(result).toEqual([]);
    });

    it('should return empty array when all feature branches exist', async () => {
      const getAllMock = vi.fn().mockResolvedValue([
        {
          id: 'f1',
          title: 'Feature 1',
          description: 'desc',
          category: 'test',
          branchName: 'feature-1',
        },
        {
          id: 'f2',
          title: 'Feature 2',
          description: 'desc',
          category: 'test',
          branchName: 'feature-2',
        },
      ] satisfies Feature[]);
      mockFeatureLoaderGetAll(service, getAllMock);
      mockGetExistingBranches(service, ['main', 'feature-1', 'feature-2']);

      const result = await service.detectOrphanedFeatures('/test/project');

      expect(result).toEqual([]);
    });

    it('should detect orphaned features with missing branches', async () => {
      const features: Feature[] = [
        {
          id: 'f1',
          title: 'Feature 1',
          description: 'desc',
          category: 'test',
          branchName: 'feature-1',
        },
        {
          id: 'f2',
          title: 'Feature 2',
          description: 'desc',
          category: 'test',
          branchName: 'deleted-branch',
        },
        { id: 'f3', title: 'Feature 3', description: 'desc', category: 'test' }, // No branch
      ];
      const getAllMock = vi.fn().mockResolvedValue(features);
      mockFeatureLoaderGetAll(service, getAllMock);
      mockGetExistingBranches(service, ['main', 'feature-1']); // deleted-branch not in list

      const result = await service.detectOrphanedFeatures('/test/project');

      expect(result).toHaveLength(1);
      expect(result[0].feature.id).toBe('f2');
      expect(result[0].missingBranch).toBe('deleted-branch');
    });

    it('should detect multiple orphaned features', async () => {
      const features: Feature[] = [
        {
          id: 'f1',
          title: 'Feature 1',
          description: 'desc',
          category: 'test',
          branchName: 'orphan-1',
        },
        {
          id: 'f2',
          title: 'Feature 2',
          description: 'desc',
          category: 'test',
          branchName: 'orphan-2',
        },
        {
          id: 'f3',
          title: 'Feature 3',
          description: 'desc',
          category: 'test',
          branchName: 'valid-branch',
        },
      ];
      const getAllMock = vi.fn().mockResolvedValue(features);
      mockFeatureLoaderGetAll(service, getAllMock);
      mockGetExistingBranches(service, ['main', 'valid-branch']);

      const result = await service.detectOrphanedFeatures('/test/project');

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.feature.id)).toContain('f1');
      expect(result.map((r) => r.feature.id)).toContain('f2');
    });

    it('should return empty array when getAll throws error', async () => {
      const getAllMock = vi.fn().mockRejectedValue(new Error('Failed to load features'));
      mockFeatureLoaderGetAll(service, getAllMock);

      const result = await service.detectOrphanedFeatures('/test/project');

      expect(result).toEqual([]);
    });

    it('should ignore empty branchName strings', async () => {
      const features: Feature[] = [
        { id: 'f1', title: 'Feature 1', description: 'desc', category: 'test', branchName: '' },
        { id: 'f2', title: 'Feature 2', description: 'desc', category: 'test', branchName: '   ' },
      ];
      const getAllMock = vi.fn().mockResolvedValue(features);
      mockFeatureLoaderGetAll(service, getAllMock);
      mockGetExistingBranches(service, ['main']);

      const result = await service.detectOrphanedFeatures('/test/project');

      expect(result).toEqual([]);
    });

    it('should skip features whose branchName matches the primary branch', async () => {
      const features: Feature[] = [
        { id: 'f1', title: 'Feature 1', description: 'desc', category: 'test', branchName: 'main' },
        {
          id: 'f2',
          title: 'Feature 2',
          description: 'desc',
          category: 'test',
          branchName: 'orphaned',
        },
      ];
      const getAllMock = vi.fn().mockResolvedValue(features);
      mockFeatureLoaderGetAll(service, getAllMock);
      mockGetExistingBranches(service, ['main', 'develop']);
      // Mock getCurrentBranch to return 'main'
      (service as any).getCurrentBranch = vi.fn().mockResolvedValue('main');

      const result = await service.detectOrphanedFeatures('/test/project');

      // Only f2 should be orphaned (orphaned branch doesn't exist)
      expect(result).toHaveLength(1);
      expect(result[0].feature.id).toBe('f2');
    });
  });

  describe('markFeatureInterrupted', () => {
    // Helper to mock updateFeatureStatus
    const mockUpdateFeatureStatus = (svc: AutoModeService, mockFn: ReturnType<typeof vi.fn>) => {
      (svc as any).updateFeatureStatus = mockFn;
    };

    // Helper to mock loadFeature
    const mockLoadFeature = (svc: AutoModeService, mockFn: ReturnType<typeof vi.fn>) => {
      (svc as any).loadFeature = mockFn;
    };

    it('should call updateFeatureStatus with interrupted status for non-pipeline features', async () => {
      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-123', status: 'in_progress' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markFeatureInterrupted('/test/project', 'feature-123');

      expect(updateMock).toHaveBeenCalledWith('/test/project', 'feature-123', 'interrupted');
    });

    it('should call updateFeatureStatus with reason when provided', async () => {
      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-123', status: 'in_progress' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markFeatureInterrupted('/test/project', 'feature-123', 'server shutdown');

      expect(updateMock).toHaveBeenCalledWith('/test/project', 'feature-123', 'interrupted');
    });

    it('should propagate errors from updateFeatureStatus', async () => {
      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-123', status: 'in_progress' });
      const updateMock = vi.fn().mockRejectedValue(new Error('Update failed'));
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await expect(service.markFeatureInterrupted('/test/project', 'feature-123')).rejects.toThrow(
        'Update failed'
      );
    });

    it('should preserve pipeline_implementation status instead of marking as interrupted', async () => {
      const loadMock = vi
        .fn()
        .mockResolvedValue({ id: 'feature-123', status: 'pipeline_implementation' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markFeatureInterrupted('/test/project', 'feature-123', 'server shutdown');

      // updateFeatureStatus should NOT be called for pipeline statuses
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('should preserve pipeline_testing status instead of marking as interrupted', async () => {
      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-123', status: 'pipeline_testing' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markFeatureInterrupted('/test/project', 'feature-123');

      expect(updateMock).not.toHaveBeenCalled();
    });

    it('should preserve pipeline_review status instead of marking as interrupted', async () => {
      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-123', status: 'pipeline_review' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markFeatureInterrupted('/test/project', 'feature-123');

      expect(updateMock).not.toHaveBeenCalled();
    });

    it('should mark feature as interrupted when loadFeature returns null', async () => {
      const loadMock = vi.fn().mockResolvedValue(null);
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markFeatureInterrupted('/test/project', 'feature-123');

      expect(updateMock).toHaveBeenCalledWith('/test/project', 'feature-123', 'interrupted');
    });

    it('should mark feature as interrupted for pending status', async () => {
      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-123', status: 'pending' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markFeatureInterrupted('/test/project', 'feature-123');

      expect(updateMock).toHaveBeenCalledWith('/test/project', 'feature-123', 'interrupted');
    });
  });

  describe('markAllRunningFeaturesInterrupted', () => {
    // Helper to access private concurrencyManager
    const getConcurrencyManager = (svc: AutoModeService) => (svc as any).concurrencyManager;

    // Helper to add a running feature via concurrencyManager
    const addRunningFeatureForInterrupt = (
      svc: AutoModeService,
      feature: { featureId: string; projectPath: string; isAutoMode: boolean }
    ) => {
      getConcurrencyManager(svc).acquire(feature);
    };

    // Helper to mock updateFeatureStatus
    const mockUpdateFeatureStatus = (svc: AutoModeService, mockFn: ReturnType<typeof vi.fn>) => {
      (svc as any).updateFeatureStatus = mockFn;
    };

    // Helper to mock loadFeature
    const mockLoadFeature = (svc: AutoModeService, mockFn: ReturnType<typeof vi.fn>) => {
      (svc as any).loadFeature = mockFn;
    };

    it('should do nothing when no features are running', async () => {
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markAllRunningFeaturesInterrupted();

      expect(updateMock).not.toHaveBeenCalled();
    });

    it('should mark a single running feature as interrupted', async () => {
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-1',
        projectPath: '/project/path',
        isAutoMode: true,
      });

      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-1', status: 'in_progress' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markAllRunningFeaturesInterrupted();

      expect(updateMock).toHaveBeenCalledWith('/project/path', 'feature-1', 'interrupted');
    });

    it('should mark multiple running features as interrupted', async () => {
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-1',
        projectPath: '/project-a',
        isAutoMode: true,
      });
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-2',
        projectPath: '/project-b',
        isAutoMode: false,
      });
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-3',
        projectPath: '/project-a',
        isAutoMode: true,
      });

      const loadMock = vi.fn().mockResolvedValue({ status: 'in_progress' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markAllRunningFeaturesInterrupted();

      expect(updateMock).toHaveBeenCalledTimes(3);
      expect(updateMock).toHaveBeenCalledWith('/project-a', 'feature-1', 'interrupted');
      expect(updateMock).toHaveBeenCalledWith('/project-b', 'feature-2', 'interrupted');
      expect(updateMock).toHaveBeenCalledWith('/project-a', 'feature-3', 'interrupted');
    });

    it('should mark features in parallel', async () => {
      for (let i = 1; i <= 5; i++) {
        addRunningFeatureForInterrupt(service, {
          featureId: `feature-${i}`,
          projectPath: `/project-${i}`,
          isAutoMode: true,
        });
      }

      const loadMock = vi.fn().mockResolvedValue({ status: 'in_progress' });
      const callOrder: string[] = [];
      const updateMock = vi.fn().mockImplementation(async (_path: string, featureId: string) => {
        callOrder.push(featureId);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      const startTime = Date.now();
      await service.markAllRunningFeaturesInterrupted();
      const duration = Date.now() - startTime;

      expect(updateMock).toHaveBeenCalledTimes(5);
      // If executed in parallel, total time should be ~10ms
      // If sequential, it would be ~50ms (5 * 10ms)
      expect(duration).toBeLessThan(40);
    });

    it('should continue marking other features when one fails', async () => {
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-1',
        projectPath: '/project-a',
        isAutoMode: true,
      });
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-2',
        projectPath: '/project-b',
        isAutoMode: false,
      });

      const loadMock = vi.fn().mockResolvedValue({ status: 'in_progress' });
      const updateMock = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Failed to update'));
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      // Should not throw even though one feature failed
      await expect(service.markAllRunningFeaturesInterrupted()).resolves.not.toThrow();

      expect(updateMock).toHaveBeenCalledTimes(2);
    });

    it('should use provided reason in logging', async () => {
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-1',
        projectPath: '/project/path',
        isAutoMode: true,
      });

      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-1', status: 'in_progress' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markAllRunningFeaturesInterrupted('manual stop');

      expect(updateMock).toHaveBeenCalledWith('/project/path', 'feature-1', 'interrupted');
    });

    it('should use default reason when none provided', async () => {
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-1',
        projectPath: '/project/path',
        isAutoMode: true,
      });

      const loadMock = vi.fn().mockResolvedValue({ id: 'feature-1', status: 'in_progress' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markAllRunningFeaturesInterrupted();

      expect(updateMock).toHaveBeenCalledWith('/project/path', 'feature-1', 'interrupted');
    });

    it('should preserve pipeline statuses for running features', async () => {
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-1',
        projectPath: '/project-a',
        isAutoMode: true,
      });
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-2',
        projectPath: '/project-b',
        isAutoMode: false,
      });
      addRunningFeatureForInterrupt(service, {
        featureId: 'feature-3',
        projectPath: '/project-c',
        isAutoMode: true,
      });

      // feature-1 has in_progress (should be interrupted)
      // feature-2 has pipeline_testing (should be preserved)
      // feature-3 has pipeline_implementation (should be preserved)
      const loadMock = vi
        .fn()
        .mockImplementation(async (_projectPath: string, featureId: string) => {
          if (featureId === 'feature-1') return { id: 'feature-1', status: 'in_progress' };
          if (featureId === 'feature-2') return { id: 'feature-2', status: 'pipeline_testing' };
          if (featureId === 'feature-3')
            return { id: 'feature-3', status: 'pipeline_implementation' };
          return null;
        });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      mockLoadFeature(service, loadMock);
      mockUpdateFeatureStatus(service, updateMock);

      await service.markAllRunningFeaturesInterrupted();

      // Only feature-1 should be marked as interrupted
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock).toHaveBeenCalledWith('/project-a', 'feature-1', 'interrupted');
    });
  });

  describe('isFeatureRunning', () => {
    // Helper to access private concurrencyManager
    const getConcurrencyManager = (svc: AutoModeService) => (svc as any).concurrencyManager;

    // Helper to add a running feature via concurrencyManager
    const addRunningFeatureForIsRunning = (
      svc: AutoModeService,
      feature: { featureId: string; projectPath: string; isAutoMode: boolean }
    ) => {
      getConcurrencyManager(svc).acquire(feature);
    };

    it('should return false when no features are running', () => {
      expect(service.isFeatureRunning('feature-123')).toBe(false);
    });

    it('should return true when the feature is running', () => {
      addRunningFeatureForIsRunning(service, {
        featureId: 'feature-123',
        projectPath: '/project/path',
        isAutoMode: true,
      });

      expect(service.isFeatureRunning('feature-123')).toBe(true);
    });

    it('should return false for non-running feature when others are running', () => {
      addRunningFeatureForIsRunning(service, {
        featureId: 'feature-other',
        projectPath: '/project/path',
        isAutoMode: true,
      });

      expect(service.isFeatureRunning('feature-123')).toBe(false);
    });

    it('should correctly track multiple running features', () => {
      addRunningFeatureForIsRunning(service, {
        featureId: 'feature-1',
        projectPath: '/project-a',
        isAutoMode: true,
      });
      addRunningFeatureForIsRunning(service, {
        featureId: 'feature-2',
        projectPath: '/project-b',
        isAutoMode: false,
      });

      expect(service.isFeatureRunning('feature-1')).toBe(true);
      expect(service.isFeatureRunning('feature-2')).toBe(true);
      expect(service.isFeatureRunning('feature-3')).toBe(false);
    });
  });
});
