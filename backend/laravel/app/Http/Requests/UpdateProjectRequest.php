<?php

namespace App\Http\Requests;

use App\Models\Project;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateProjectRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user() !== null;
    }

    public function rules(): array
    {
        return [
            'title' => ['sometimes', 'required', 'string', 'max:255'],
            'description' => ['sometimes', 'nullable', 'string'],
            'content_type' => ['sometimes', 'nullable', 'string', Rule::in(Project::CONTENT_TYPES)],
            'status' => ['sometimes', 'required', 'string', Rule::in(Project::STATUSES)],
        ];
    }
}
