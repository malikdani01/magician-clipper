<?php

namespace Tests\Unit;

use App\Models\ProcessingJob;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

class ProcessingJobStateTest extends TestCase
{
    public function test_valid_transitions_are_allowed(): void
    {
        $job = new ProcessingJob(['state' => ProcessingJob::STATE_UPLOADED]);

        $this->assertTrue($job->canTransitionTo(ProcessingJob::STATE_QUEUED));
        $this->assertTrue($job->canTransitionTo(ProcessingJob::STATE_CANCELLING));
        $this->assertFalse($job->canTransitionTo(ProcessingJob::STATE_COMPLETED));
        // A not-yet-started job can be cancelled directly (no worker
        // is involved, so there is nothing to stop first).
        $this->assertTrue($job->canTransitionTo(ProcessingJob::STATE_CANCELLED));
    }

    public function test_in_flight_job_cannot_jump_straight_to_cancelled(): void
    {
        // Once processing has started, cancellation must go through
        // 'cancelling' so the worker gets a chance to stop cleanly.
        $job = new ProcessingJob(['state' => ProcessingJob::STATE_RENDERING]);

        $this->assertTrue($job->canTransitionTo(ProcessingJob::STATE_CANCELLING));
        $this->assertFalse($job->canTransitionTo(ProcessingJob::STATE_CANCELLED));
    }

    public function test_failed_job_can_only_retry_to_queued(): void
    {
        $job = new ProcessingJob(['state' => ProcessingJob::STATE_FAILED]);

        $this->assertTrue($job->canTransitionTo(ProcessingJob::STATE_QUEUED));
        $this->assertFalse($job->canTransitionTo(ProcessingJob::STATE_COMPLETED));
        $this->assertFalse($job->canTransitionTo(ProcessingJob::STATE_RENDERING));
    }

    public function test_terminal_states_have_no_outgoing_transitions(): void
    {
        foreach (ProcessingJob::TERMINAL_STATES as $state) {
            $job = new ProcessingJob(['state' => $state]);
            $this->assertSame([], ProcessingJob::VALID_TRANSITIONS[$state]);
            $this->assertTrue($job->isTerminal());
        }
    }

    public function test_rendering_may_skip_captioning_to_validating(): void
    {
        $job = new ProcessingJob(['state' => ProcessingJob::STATE_RENDERING]);

        $this->assertTrue($job->canTransitionTo(ProcessingJob::STATE_CAPTIONING));
        $this->assertTrue($job->canTransitionTo(ProcessingJob::STATE_VALIDATING));
        $this->assertFalse($job->canTransitionTo(ProcessingJob::STATE_TRANSCRIBING));
    }

    public function test_invalid_transition_throws(): void
    {
        $job = new ProcessingJob(['state' => ProcessingJob::STATE_UPLOADED]);

        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Invalid job state transition: uploaded -> completed');

        $job->assertValidTransition(ProcessingJob::STATE_COMPLETED);
    }

    public function test_unknown_state_throws(): void
    {
        $job = new ProcessingJob(['state' => ProcessingJob::STATE_UPLOADED]);

        $this->expectException(InvalidArgumentException::class);

        $job->assertValidTransition('not_a_state');
    }

    public function test_every_state_is_covered_by_valid_transitions(): void
    {
        $this->assertSame(
            ProcessingJob::STATES,
            array_keys(ProcessingJob::VALID_TRANSITIONS)
        );
    }
}
